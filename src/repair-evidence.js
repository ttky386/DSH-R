function singlePluginAction(action) {
  return ['runtime-schema-leaf', 'runtime-import-leaf'].includes(action.proof)
}

/** 仅识别验证器实际错误语法，不回显字段值，也不猜应替换为什么值。 */
export function parseConfigurationIssue(reason) {
  const text = String(reason || '')
  const field = /\$\.([\w.[\]-]+)/.exec(text)?.[1]
  const missing = /(?:\$\.)?([A-Za-z][\w.]*) missing required value/.exec(text)
  if (missing) {
    return { kind: 'missing', field: missing[1], source: 'validator_log' }
  }
  if (!/ValidationError/.test(text)) {
    return null
  }
  if (!field) {
    return { kind: 'validation', field: null, source: 'validator_log' }
  }
  const expected = /expected ([^\r\n]+?) but got /.exec(text)?.[1]
  if (expected && /^(?:number|string length|array length) (?:<=|>=|multiple of) -?[\d.eE+-]+$/.test(expected)) {
    return { kind: 'range', field, constraint: expected, source: 'validator_log' }
  }
  if (expected && /^(?:string|number|boolean|array|object|function|nullable|ArrayBufferSource)(?: or array)?$/.test(expected)) {
    return { kind: 'type', field, expected, source: 'validator_log' }
  }
  if (expected && /^(?:"[^"\r\n]*"|'[^'\r\n]*'|true|false|-?\d+)(?:\s*\|\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|true|false|-?\d+))+$/.test(expected)) {
    return { kind: 'enum', field, source: 'validator_log' }
  }
  return { kind: 'validation', field, source: 'validator_log' }
}

/** 等待日志只证明缺少服务及消费者，不能由名称补造提供者或完整闭包。 */
export function waitingServiceEvidence(report) {
  const services = new Map()
  for (const row of report.waiting || []) {
    const observed = report.runtimeEvidence?.rows?.find(item => item.id === row.id && item.component === row.package && item.state === 'pending')
    for (const service of row.missing || []) {
      if (!services.has(service)) {
        services.set(service, { service, consumers: [], provider: null, level: 'logged', source: 'current_process_log', completeClosure: false })
      }
      services.get(service).consumers.push({ id: row.id, component: row.package || null, required: typeof observed?.required === 'boolean' ? observed.required : row.required ?? null, requiredSource: typeof observed?.required === 'boolean' ? 'official_runtime_audit' : row.required === true ? 'current_process_log' : 'unconfirmed' })
    }
  }
  return [...services.values()]
}

/** 将当前日志、解析证据和可执行范围分开；组件名称不参与根因推断。 */
export function buildRepairPresentation(actions, report, inspected, target) {
  const groups = new Map()
  for (const action of actions) {
    if (!groups.has(action.component)) {
      groups.set(action.component, [])
    }
    groups.get(action.component).push(action)
  }
  const problems = []
  for (const [component, alternatives] of groups) {
    const observations = []
    for (const row of report.failed || []) {
      if ((row.package || row.id) !== component) {
        continue
      }
      const validation = parseConfigurationIssue(row.reason)
      observations.push({ id: `log:${observations.length}`, kind: 'activation_failure', source: 'current_process_log', rowId: row.id, reason: row.reason, required: row.required ?? null, ...(validation ? { field: validation.field, validation } : {}) })
    }
    for (const row of report.rejected || []) {
      if (row.package !== component && !row.package?.startsWith(component + '@')) {
        continue
      }
      observations.push({ id: `log:${observations.length}`, kind: 'version_rejection', source: 'current_process_log', rowId: row.id, package: row.package, runtime: row.runtime, requirements: row.requirements })
    }
    for (const row of report.skipped?.entries || []) {
      if ((row.package || row.packageName) === component) {
        observations.push({ id: `log:${observations.length}`, kind: 'bundle_skipped', source: 'current_process_log', reason: row.reason })
      }
    }
    const confirmations = []
    const unknowns = []
    const selected = inspected.packages?.find(row => row.name === component)
    for (const owner of selected?.dependencyOwners || []) {
      const candidate = inspected.introducers?.find(item => item.component === component && item.owner.dir === owner.dir)
      confirmations.push({ id: `dependency:${owner.dir}:${owner.field}`, kind: 'installed_dependency', source: owner.installed ? 'lockfile_layout_and_official_resolver' : 'manifest_and_official_resolver', owner: owner.name, version: owner.version, field: owner.field, target: owner.target, disabled: candidate?.entries?.length ? candidate.entries.every(entry => entry.disabled) : null, verifiedInstallation: owner.installed, path: owner.manifest })
    }
    if (inspected.dependencyReason) {
      unknowns.push({ code: 'dependency_evidence', detail: inspected.dependencyReason })
    }
    const disableCandidate = inspected.disableCandidates?.find(row => row.component === component && row.sourceConfirmed && observations.some(item => item.rowId === row.id))
    if (disableCandidate) {
      if (!disableCandidate.disabledReason) {
        confirmations.push({ id: 'runtime:schema', kind: disableCandidate.proof === 'runtime-import-leaf' ? 'fatal_import_before_apply' : 'schema_before_execution', source: 'official_runtime_audit', rowId: disableCandidate.id, required: false, executions: 0 })
      }
      confirmations.push({ id: 'probe:effective-config', kind: 'effective_configuration', source: 'official_composition', rowId: disableCandidate.id, digest: disableCandidate.optionsDigest })
      confirmations.push({ id: 'probe:resolution', kind: 'resolved_package', source: 'official_resolver', path: disableCandidate.source, version: disableCandidate.version })
    }
    if (selected?.sourceConfirmed) {
      confirmations.push({ id: 'probe:resolution', kind: 'resolved_package', source: 'official_resolver', path: selected.selected.dir, version: selected.selected.version })
      if (!selected.disabledReason && selected.replacement) {
        confirmations.push({ id: 'probe:replacement', kind: 'compatible_replacement', source: 'official_compatibility_and_fallback', path: selected.replacement.dir, version: selected.replacement.version })
      }
    }
    for (const source of inspected.configurationEvidence || []) {
      if (source.component !== component || !observations.some(item => item.rowId === source.rowId && item.field === source.field)) {
        continue
      }
      if (source.confirmed) {
        confirmations.push({ id: `probe:config:${source.rowId}`, kind: 'configuration_source', ...source })
        if (source.environment?.variable) {
          confirmations.push({ id: `runtime:environment:${source.rowId}`, kind: 'launch_variable_presence', source: 'captured_validation_environment', variable: source.environment.variable, present: source.environment.present })
        } else if (source.environment) {
          unknowns.push({ code: 'complex_environment_expression', detail: '字段使用复杂表达式；没有额外求值，无法确认具体环境变量来源。' })
        }
        unknowns.push({ code: 'configuration_source_time', detail: '文件归属来自当前文件合成，并与本次运行条目摘要一致；未记录启动瞬间各层文件内容，不能证明文件从未变化。' })
      }
      if (source.reason) {
        unknowns.push({ code: 'configuration_source_incomplete', detail: source.reason })
      }
    }
    const declaration = report.runtimeEvidence?.declarationEvidence?.find(item => item.component === component && observations.some(observation => observation.rowId === item.id))
    if (declaration) {
      if (declaration.service && declaration.unregistered) {
        confirmations.push({ id: 'runtime:service-declaration', kind: 'unregistered_service_declaration', source: declaration.source, rowId: declaration.id, service: declaration.service, consumers: declaration.consumers })
      }
      if (declaration.reason) {
        unknowns.push({ code: 'service_declaration_unconfirmed', detail: declaration.reason })
      }
    }
    if (!confirmations.some(item => item.kind === 'resolved_package' || item.kind === 'configuration_source')) {
      unknowns.push({ code: 'source_unconfirmed', detail: '实际配置层及加载来源尚未核实；动作是否受支持不等于来源是否已确认。' })
    }
    if (alternatives.some(action => action.proof === 'runtime-import-leaf')) {
      unknowns.push({ code: 'import_side_effects_unknown', detail: '模块顶层可能已执行；副作用及完整依赖影响未确认。禁用不会撤销此前副作用，其他等待条目不会被关闭。' })
    }
    const validation = observations.find(item => item.validation)
    const rejected = observations.find(item => item.kind === 'version_rejection')
    const classification = {
      kind: rejected ? 'compatibility' : validation ? 'configuration' : observations.length ? 'plugin' : 'unclassified',
      ruleId: rejected ? 'loader_rejection' : validation ? `schema_${validation.validation.kind}` : observations.length ? 'activation_report' : 'insufficient_evidence',
      evidenceRefs: observations.map(item => item.id),
    }
    const reviewedDependencies = inspected.optionalDependencies || []
    const reviewedRows = [...new Set(reviewedDependencies.flatMap(edge => [edge.from.id, edge.to.id]))]
    const matchesReviewedGroup = Boolean(inspected.optionalProof?.allowed && reviewedRows.length && alternatives.some(action =>
      action.kind === 'disable-optional' && !singlePluginAction(action) &&
      reviewedDependencies.some(edge => edge.to.component === component) &&
      Array.isArray(action.rows) && action.rows.length === reviewedRows.length && reviewedRows.every(id => action.rows.includes(id))))
    const dependencies = matchesReviewedGroup ? reviewedDependencies : []
    if (alternatives.some(action => action.kind === 'disable-optional' && !singlePluginAction(action)) && !dependencies.length) {
      unknowns.push({ code: 'dependencies_unconfirmed', detail: '没有已核实的可选依赖关系，不能据组件名称推断。' })
    }
    if (validation && !validation.field) {
      unknowns.push({ code: 'configuration_field_unconfirmed', detail: '错误报告配置校验失败，但未提取到字段位置。' })
    }
    if (alternatives.every(action => action.kind === 'unsupported')) {
      unknowns.push({ code: 'action_unsupported', detail: '尚无已验证的可执行方案；没有修改配置值或禁用任何组件。' })
    }
    const problem = { component, observations, confirmations, classification, unknowns, dependencies, capability: matchesReviewedGroup ? { kind: 'reviewed_build', fingerprint: inspected.optionalProof.fingerprint } : null }
    problems.push(problem)
    for (const action of alternatives) {
      action.problem = problem
      const steps = []
      if (action.kind === 'package') {
        steps.push({ operation: 'archive_package', source: action.source, backup: action.backup, replacement: action.replacement, beforeVersion: action.currentVersion || null, afterVersion: action.targetVersion || null })
      } else if (action.kind === 'uninstall-introducer') {
        steps.push({ operation: 'uninstall_introducer', owner: action.owner, path: action.source, affected: action.affected, predicted: action.predicted })
      } else if (action.kind === 'disable-optional') {
        const rows = singlePluginAction(action) ? (action.rows || []).map(id => ({ id, component: action.component })) : dependencies.length ? [...new Map(dependencies.flatMap(edge => [[edge.from.id, edge.from], [edge.to.id, edge.to]])).values()] : []
        steps.push({ operation: 'disable_rows', path: action.source, rows })
      }
      action.solution = { kind: action.kind, steps, effects: { scope: target, restart: steps.length > 0, versionsUnchanged: !['package', 'uninstall-introducer'].includes(action.kind), bypass: action.kind === 'disable-optional', dependencies }, rollback: steps.length && action.kind !== 'uninstall-introducer' ? { source: action.backup, target: action.source } : null, verified: !action.disabledReason }
    }
  }
  const waitingServices = waitingServiceEvidence(report)
  for (const relation of waitingServices) {
    relation.declarations = (report.runtimeEvidence?.declarationEvidence || []).filter(item => item.service === relation.service && item.unregistered === true && !item.reason && item.consumers.some(consumer => relation.consumers.some(observed => observed.id === consumer.id && observed.component === consumer.component))).map(item => ({ id: item.id, component: item.component, service: item.service, consumers: item.consumers, source: item.source }))
    const providers = problems.flatMap(problem => problem.dependencies).filter(edge => edge.service === relation.service)
    if (providers.length) {
      relation.provider = providers.map(edge => ({ ...edge.to, source: edge.source }))
    }
  }
  return { actions, problems, waitingServices }
}

/** 历史只使用已持久化的写入事实；旧记录缺少执行证据时保持未知。 */
export function recordedChanges(record) {
  if (Array.isArray(record.actualChanges)) {
    return { changes: record.actualChanges, rollbackChanges: record.rollbackChanges || [], unknowns: !record.actualChanges.length || !['applied', 'rolled_back'].includes(record.status) ? ['仅列出已持久化确认的步骤；中断或失败后的未记录修改尚未确认，不能据此断定未发生。'] : [], source: 'execution_record' }
  }
  const changes = []
  const action = record.action || {}
  const completed = ['applied', 'applied_verification_failed', 'rolled_back'].includes(record.status)
  if (completed && action.kind === 'package' && record.packageDigest) {
    changes.push({ operation: 'archive_package', path: action.source, backup: action.backup, before: { version: action.currentVersion || null }, after: { candidateVersion: action.targetVersion || null }, source: 'legacy_completed_record' })
  } else if (completed && action.kind === 'client-version' && record.adapter) {
    changes.push({ operation: 'set_launch_adapter', path: action.source, before: { previousAdapterPresent: record.before !== null }, after: { adapterWritten: true }, source: 'legacy_completed_record' })
  } else if (completed && action.kind === 'disable-optional' && record.patchBeforeDigest && record.patchAppliedDigest) {
    changes.push({ operation: 'patch_written', path: action.source, before: { digest: record.patchBeforeDigest }, after: { digest: record.patchAppliedDigest }, rows: action.rows || [], source: 'legacy_completed_record' })
  }
  return { changes, rollbackChanges: record.rollbackChanges || (record.status === 'rolled_back' && record.rollbackAt ? [{ operation: 'restore_backup', source: 'legacy_completed_record', path: action.source, backup: action.backup }] : []), unknowns: changes.length ? ['旧记录未逐步保存全部修改与解析后状态；未记录的细节不补造。'] : ['此记录没有足够的持久执行证据，实际完成的修改未确认。'], source: 'legacy_record' }
}
