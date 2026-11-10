import { createHash } from 'node:crypto'
import { packageFingerprint } from './diagnostic-repair.js'
import { configurationEnvironment, configurationField, declaredService } from './configuration-evidence.js'
import { parseConfigurationIssue } from './repair-evidence.js'

export const RUNTIME_EVIDENCE_PREFIX = 'DSH_X_RUNTIME_EVIDENCE '
const MAX_ENTRIES = 512
const MAX_FIBERS = 2048
const MAX_BYTES = 65536
const MAX_DEPTH = 32
const MAX_CANDIDATES = 16
// 官方 dsh-app-boot 的 FIBER_ACTIVE（启动审计使用同一 Cordis 状态）。
const FIBER_ACTIVE = 2

/** 原始配置只比较摘要；不输出值，不接受函数、循环或非JSON对象。 */
export function optionsDigest(value) {
  const seen = new Set()
  function visit(item, depth) {
    if (depth > MAX_DEPTH || typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint') {
      throw new Error('unverifiable_options')
    }
    if (item === null || typeof item !== 'object') {
      return item
    }
    if (seen.has(item) || (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)) {
      throw new Error('unverifiable_options')
    }
    seen.add(item)
    const result = Array.isArray(item) ? item.map(child => visit(child, depth + 1)) : Object.fromEntries(Object.keys(item).sort().map(key => [key, visit(item[key], depth + 1)]))
    seen.delete(item)
    return result
  }
  const serialized = JSON.stringify(visit(value, 0))
  if (!serialized || Buffer.byteLength(serialized) > MAX_BYTES) {
    throw new Error('oversized_options')
  }
  return createHash('sha256').update(serialized).digest('hex')
}

/** 状态只属于本次Harness进程，WeakMap不延长fiber生命周期。 */
export class RuntimeDiagnostics {
  constructor() {
    this.fibers = new WeakMap()
    this.serviceClass = null
    this.isolateSymbol = null
    this.schemaErrors = new WeakSet()
    this.importErrors = new WeakMap()
    this.importAudits = new WeakMap()
    this.bootScopes = new WeakMap()
    this.rootScopes = new WeakMap()
    this.serviceRegistrations = new WeakMap()
    this.unloadedBindings = new WeakMap()
  }

  /** 记录实际隔离键的最近一次服务登记，使替换后旧归属失效。 */
  serviceProvided(reflect, key, implementation) {
    try {
      let registrations = this.serviceRegistrations.get(reflect.store)
      if (!registrations) {
        registrations = new Map()
        this.serviceRegistrations.set(reflect.store, registrations)
      }
      if (registrations.size < MAX_FIBERS || registrations.has(key)) {
        registrations.set(key, implementation)
      }
    } catch {
      // 观察器不改变官方服务注册或清理。
    }
  }

  /** 官方重载入口推进代次，不改变执行或清理。 */
  reload(fiber) {
    try {
      this.state(fiber).generation += 1
      this.unloadedBindings.delete(fiber)
    } catch {
      // 重试开始即使旧错误对象尚在，也不得复用上一代归属。
    }
  }

  /** 失败清理前保留同一作用域消费者实际解析到的服务实现。 */
  beforeUnload(provider, isolateSymbol) {
    try {
      if (!provider._error || !provider.ctx.root || !isolateSymbol) {
        return
      }
      const entries = [...provider.ctx.loader.entries()]
      if (entries.length > MAX_ENTRIES) {
        return
      }
      const owners = entries.filter(entry => entry.fiber === provider)
      if (owners.length !== 1) {
        return
      }
      const owner = owners[0]
      const store = provider.ctx.reflect.store
      const keys = Reflect.ownKeys(store)
      if (keys.length > MAX_FIBERS) {
        return
      }
      const registrations = this.serviceRegistrations.get(store)
      for (const entry of entries) {
        const consumer = entry.fiber
        const names = Object.keys(consumer?.inject || {})
        if (names.length > MAX_ENTRIES) {
          continue
        }
        for (const service of names) {
          const implementation = consumer.ctx.reflect._getImpl(service, false)
          const key = keys.find(candidate => store[candidate] === implementation)
          if (!implementation || implementation.fiber !== provider || registrations?.get(key) !== implementation || consumer.ctx.root !== provider.ctx.root || consumer.ctx.reflect.store !== store || consumer.ctx[isolateSymbol]?.[service] !== key) {
            continue
          }
          let bindings = this.unloadedBindings.get(consumer)
          if (!bindings) {
            bindings = new Map()
            this.unloadedBindings.set(consumer, bindings)
          }
          if (bindings.size >= MAX_ENTRIES && !bindings.has(service)) {
            continue
          }
          bindings.set(service, {
            root: provider.ctx.root, owner, entry, provider, consumer, store, key, implementation, isolateSymbol,
            ownerOptions: owner.options, entryOptions: entry.options,
            ownerDigest: optionsDigest(owner.options), entryDigest: optionsDigest(entry.options),
            providerRunner: provider._runner, consumerRunner: consumer._runner,
            providerGeneration: this.state(provider).validations, consumerGeneration: this.state(consumer).validations,
            providerReload: this.state(provider).generation, consumerReload: this.state(consumer).generation,
            error: provider._error,
          })
        }
      }
    } catch {
      // 清理前无法完整取得真实绑定就保留未知，不依据服务名猜测提供者。
    }
  }

  /** 清理后仅复用身份、隔离键、代次、配置及错误均未变化的绑定。 */
  unloadedImplementation(ctx, consumer, service, entries, failures) {
    const record = this.unloadedBindings.get(consumer.fiber)?.get(service)
    if (!record || !record.root || record.root !== ctx.root || consumer.fiber.ctx.root !== record.root || consumer.fiber.ctx.reflect.store !== record.store || consumer.fiber.ctx[record.isolateSymbol]?.[service] !== record.key || record.entry !== consumer || record.consumer !== consumer.fiber || !entries.includes(record.owner) || record.owner.fiber !== record.provider) {
      return null
    }
    if (record.entryOptions !== consumer.options || record.ownerOptions !== record.owner.options || record.entryDigest !== optionsDigest(consumer.options) || record.ownerDigest !== optionsDigest(record.owner.options)) {
      return null
    }
    if (record.providerRunner !== record.provider._runner || record.consumerRunner !== consumer.fiber._runner || record.providerGeneration !== this.state(record.provider).validations || record.consumerGeneration !== this.state(consumer.fiber).validations) {
      return null
    }
    if (record.providerReload !== this.state(record.provider).generation || record.consumerReload !== this.state(consumer.fiber).generation) {
      return null
    }
    if (record.store[record.key] || this.serviceRegistrations.get(record.store)?.get(record.key) !== record.implementation || record.provider._error !== record.error) {
      return null
    }
    return failures.some(item => item.entry === record.owner && item.outcome.kind === 'failed' && item.outcome.error === record.error) ? record.implementation : null
  }

  registerBoot(ctx, requiredIds) {
    try {
      this.bootScopes.set(ctx, { ctx, requiredIds: new Set(requiredIds), rootOptions: null })
    } catch {
      // 缺少官方启动作用域则不开放早期导入诊断动作。
    }
  }

  registerRoot(ctx, rootOptions) {
    try {
      const scope = this.bootScopes.get(ctx)
      if (scope) {
        scope.rootOptions = rootOptions
        this.rootScopes.set(rootOptions, scope)
      }
    } catch {
      // 不改变官方根配置对象。
    }
  }

  earlyImportSnapshot(entry, error) {
    const tree = entry.parent?.tree
    const bootstrap = tree?.ctx?.fiber?.entry
    const scope = bootstrap?.options && this.rootScopes.get(bootstrap.options)
    if (!scope?.rootOptions || bootstrap?.options !== scope.rootOptions || entry.parent !== tree.root || !Array.isArray(tree.root.data) || tree.root.data.length > MAX_ENTRIES) {
      return null
    }
    const rows = tree.root.data
    const ids = new Set()
    const required = new Set()
    for (const options of rows) {
      if (!options || Object.getPrototypeOf(options) !== Object.prototype || Reflect.ownKeys(options).some(key => {
        const descriptor = Object.getOwnPropertyDescriptor(options, key)
        return descriptor?.get || descriptor?.set
      })) {
        return null
      }
      if (typeof options.id !== 'string' || ids.has(options.id) || options.group || options.name === 'cordis:include' || options.name === 'cordis:group') {
        return null
      }
      ids.add(options.id)
      const current = tree.store[options.id]
      if (!current || current.options !== options || current.parent !== tree.root || current.subtree || current.subgroup) {
        return null
      }
      if (scope.requiredIds.has(options.id) && current.fiber?.state !== FIBER_ACTIVE && options.disabled !== true) {
        required.add(current)
      }
    }
    if (Object.keys(tree.store).some(id => !ids.has(id))) {
      return null
    }
    if (bootstrap.fiber?.state !== FIBER_ACTIVE) {
      required.add(bootstrap)
    }
    const failures = [{ entry, outcome: { kind: 'failed', phase: 'failed to import', error } }]
    const snapshot = this.snapshot(scope.ctx, failures, required, bootstrap)
    const row = snapshot.rows[0]
    row.required = scope.requiredIds.has(entry.options.id)
    if (!row.importBeforeApply || !row.selected) {
      return null
    }
    row.selected.contentDigest = packageFingerprint(row.selected.dir)
    row.fatalImport = true
    return { ...snapshot, phase: 'initializing' }
  }

  importFailure(entry, error) {
    try {
      if (!(error instanceof Error) || entry.fiber || entry.moduleNamespace) {
        return
      }
      const owners = this.importErrors.get(error) || new Set()
      owners.add(entry)
      this.importErrors.set(error, owners)
    } catch {
      // 导入错误仍交给官方处理；观察器不重抛或吞掉官方错误。
    }
  }

  rememberImportAudit(failures, snapshot) {
    for (const { entry, outcome } of failures) {
      const owners = this.importErrors.get(outcome.error)
      const row = snapshot.rows.find(item => item.id === entry.options.id && item.component === entry.options.name)
      if (outcome.phase === 'failed to import' && owners?.size === 1 && owners.has(entry) && row?.importBeforeApply && row.selected?.contentDigest) {
        this.importAudits.set(outcome.error, { entry, snapshot, row })
      }
    }
  }

  fatalSnapshot(error) {
    const audit = this.importAudits.get(error)
    const owners = this.importErrors.get(error)
    if (owners?.size !== 1) {
      return null
    }
    const entry = [...owners][0]
    if (entry.fiber || entry.moduleNamespace || (audit && !owners.has(audit.entry))) {
      return null
    }
    // audit 只证明阶段；目标、配置、状态和依赖必须在致命退出现场重新采集。
    const current = this.earlyImportSnapshot(entry, error)
    return current ? { ...current, phase: audit ? 'settled' : 'initializing' } : null
  }

  fatal(error) {
    try {
      const snapshot = this.fatalSnapshot(error)
      if (snapshot) {
        this.emit(snapshot)
      }
    } catch {
      // 官方 fail-loud 的输出、退出和清理顺序不依赖旁路证据。
    }
  }

  emit(snapshot) {
    const nonce = process.env.DSH_X_DIAGNOSTIC_ATTEMPT
    if (!/^[a-f0-9]{32}$/.test(nonce || '')) {
      return
    }
    let serialized = JSON.stringify({ nonce, ...snapshot })
    if (Buffer.byteLength(serialized) > MAX_BYTES) {
      const { declarationEvidence, ...base } = snapshot
      serialized = JSON.stringify({ nonce, ...base, rows: base.rows.map(({ configuration, ...row }) => row) })
    }
    if (Buffer.byteLength(serialized) <= MAX_BYTES) {
      process.stdout.write(RUNTIME_EVIDENCE_PREFIX + serialized + '\n')
    }
  }

  state(fiber) {
    if (!this.fibers.has(fiber)) {
      this.fibers.set(fiber, { validations: 0, executions: 0, schemaFailed: false, generation: 0 })
    }
    return this.fibers.get(fiber)
  }

  execute(fiber, runner) {
    try {
      if (runner === fiber._runner) {
        this.state(fiber).executions += 1
      }
    } catch {
      // 旁路证据失败不改变官方执行。
    }
  }

  /** 仅在官方配置求值前记录直接变量存在性，不执行表达式。 */
  configurationStart(fiber) {
    try {
      const state = this.state(fiber)
      state.configurationCapture = { raw: fiber._config, digest: optionsDigest(fiber._config || {}), environment: configurationEnvironment(fiber._config, process.env) }
      state.configuration = null
    } catch {
      // 证据不足不影响配置求值或原错误。
    }
  }

  /** 类身份由同一官方 Cordis 模块传入，避免以类名认定提供者。 */
  registerServiceClass(serviceClass, isolateSymbol) {
    this.serviceClass = serviceClass
    this.isolateSymbol = isolateSymbol
  }

  validate(fiber, operation, evaluatedConfig) {
    let state
    try {
      state = this.state(fiber)
      state.validations += 1
      state.schemaFailed = false
    } catch {
      return operation()
    }
    try {
      return operation()
    } catch (error) {
      try {
        state.schemaFailed = this.schemaErrors.has(error)
        const issue = state.schemaFailed && parseConfigurationIssue(`${error?.name || 'Error'}: ${error?.message || ''}`)
        const captured = state.configurationCapture
        if (issue?.field && captured?.raw === fiber._config && captured.digest === optionsDigest(fiber._config || {})) {
          state.configuration = { field: issue.field, ...configurationField(evaluatedConfig, issue.field), environment: captured.environment.find(item => item.field === issue.field) || null }
        }
      } catch {
        // 不允许旁路记账替换官方抛出的错误。
      }
      throw error
    }
  }

  schemaError(error) {
    try {
      this.schemaErrors.add(error)
    } catch {
      // 错误仍由官方调用点抛出，观察失败不替换原错误。
    }
    return error
  }

  snapshot(ctx, failures, required, bootstrap) {
    const entries = [...ctx.loader.entries()]
    if (entries.length > MAX_ENTRIES || failures.length > MAX_ENTRIES) {
      throw new Error('oversized_entries')
    }
    const fibers = []
    for (const runtime of ctx.registry.values()) {
      for (const fiber of runtime.fibers) {
        fibers.push(fiber)
        if (fibers.length > MAX_FIBERS) {
          throw new Error('oversized_fibers')
        }
      }
    }
    const store = ctx.reflect.store
    const services = Reflect.ownKeys(store).map(key => store[key])
    function descendant(candidate, parent) {
      const visited = new Set()
      let current = candidate
      while (current && !visited.has(current)) {
        if (current === parent) {
          return true
        }
        visited.add(current)
        if (visited.size > MAX_DEPTH) {
          throw new Error('unverifiable_ownership')
        }
        current = current.parent?.fiber
      }
      return false
    }
    // Cordis 的实际服务实现绑定才构成边；同名等待和未知提供者不构成归因。
    const dependencies = []
    const failedEntries = new Set(failures.filter(item => item.outcome.kind === 'failed').map(item => item.entry))
    const uniqueIds = new Set(entries.filter(entry => entries.filter(candidate => candidate.options.id === entry.options.id).length === 1).map(entry => entry.options.id))
    for (const consumer of entries) {
      for (const service of Object.keys(consumer.fiber?.inject || {})) {
        const implementation = consumer.fiber.ctx.reflect._getImpl(service, false) || this.unloadedImplementation(ctx, consumer, service, entries, failures)
        if (!implementation?.fiber || implementation.fiber.state === FIBER_ACTIVE || consumer.fiber._store?.[service]) {
          continue
        }
        const directProviders = entries.filter(candidate => candidate.fiber === implementation.fiber)
        const providers = directProviders.length ? directProviders : entries.filter(candidate => candidate.fiber && descendant(implementation.fiber, candidate.fiber))
        if (providers.length === 1) {
          dependencies.push({ from: consumer, to: providers[0], service })
          if (dependencies.length > MAX_FIBERS) {
            throw new Error('oversized_dependency_edges')
          }
        }
      }
    }
    const requiredDependencyChains = []
    let traversedEdges = 0
    for (const requiredEntry of required) {
      const queue = [{ entry: requiredEntry, edges: [], visited: new Set() }]
      while (queue.length) {
        const current = queue.shift()
        if (current.visited.has(current.entry) || current.edges.length >= MAX_DEPTH) {
          continue
        }
        const visited = new Set([...current.visited, current.entry])
        for (const edge of dependencies.filter(item => item.from === current.entry)) {
          traversedEdges += 1
          if (traversedEdges > MAX_FIBERS) {
            throw new Error('oversized_dependency_traversal')
          }
          const edges = [...current.edges, edge]
          if (failedEntries.has(edge.to) && edges.every(item => uniqueIds.has(item.from.options.id) && uniqueIds.has(item.to.options.id))) {
            // 局部 id 可在不同 include 下重名；只有实际对象路径成立后才转成展示字段。
            requiredDependencyChains.push({ requiredId: requiredEntry.options.id, targetId: edge.to.options.id, edges: edges.map(item => ({ from: item.from.options.id, to: item.to.options.id, service: item.service })) })
          }
          if (requiredDependencyChains.length > MAX_ENTRIES) {
            throw new Error('oversized_dependency_evidence')
          }
          queue.push({ entry: edge.to, edges, visited })
        }
      }
    }
    return {
      phase: 'settled',
      declarationEvidence: this.declarationEvidence(entries, failures),
      requiredDependencyChains,
      requiredInactive: [...required].map(entry => entry.options.id),
      rows: failures.map(({ entry, outcome }) => {
        const fiber = entry.fiber
        const state = fiber && this.fibers.get(fiber)
        const base = entry.parent.tree.ctx.baseUrl
        const selected = ctx.get('pluginPackages')?.packageOf(entry.options.name, base)
        const unique = entries.filter(item => item.options.id === entry.options.id).length === 1
        const importBeforeApply = !fiber && !entry.moduleNamespace && this.importErrors.get(outcome.error)?.has(entry) === true
        return {
          id: entry.options.id,
          entryId: entry.id,
          component: entry.options.name,
          base,
          required: required.has(entry),
          state: outcome.kind,
          firstSchemaFailure: Boolean(state?.schemaFailed && state.validations === 1 && state.executions === 0 && outcome.kind === 'failed'),
          executions: importBeforeApply ? 0 : state?.executions ?? null,
          importBeforeApply,
          unique,
          topLevel: Boolean(bootstrap?.subtree?.root && entry.parent === bootstrap.subtree.root),
          leaf: !entry.options.group && !entry.subtree && !entry.subgroup,
          descendants: fiber ? fibers.filter(item => item !== fiber && descendant(item, fiber)).length : importBeforeApply ? 0 : null,
          ownedServices: fiber ? services.filter(item => item?.fiber && descendant(item.fiber, fiber)).length : importBeforeApply ? 0 : null,
          ...(state?.schemaFailed && state.configuration && state.configurationCapture?.raw === entry.options.config && state.configurationCapture.digest === optionsDigest(entry.options.config || {}) ? { configuration: state.configuration } : {}),
          optionsDigest: optionsDigest(entry.options),
          selected: selected ? { dir: selected.dir, name: selected.name, version: selected.version } : null,
        }
      }),
    }
  }

  /** 首次 provide 才创建公共服务键；缺键时必须证实原型链继承同一根隔离表。 */
  declarationScope(context, service) {
    const rootMap = context?.root?.[this.isolateSymbol]
    let map = context?.[this.isolateSymbol]
    if (!rootMap || !map) {
      return null
    }
    const visited = new Set()
    while (map && visited.size < MAX_DEPTH && !visited.has(map)) {
      visited.add(map)
      const descriptor = Object.getOwnPropertyDescriptor(map, service)
      if (descriptor) {
        return typeof descriptor.value === 'symbol' ? descriptor.value : null
      }
      if (map === rootMap) {
        return Object.getPrototypeOf(rootMap) === null ? rootMap : null
      }
      map = Object.getPrototypeOf(map)
    }
    return null
  }

  /** 未执行构造的声明与当前等待并列展示；不进入任何禁用门禁。 */
  declarationEvidence(entries, failures) {
    const result = []
    try {
      const declarations = entries.map(entry => ({ entry, declaration: declaredService(entry.fiber?.runtime?.callback, this.serviceClass) }))
      for (const { entry, outcome } of failures) {
        const state = entry.fiber && this.fibers.get(entry.fiber)
        if (outcome.kind !== 'failed' || !state?.schemaFailed || state.executions !== 0 || result.length >= MAX_CANDIDATES) {
          continue
        }
        if (entries.filter(item => item.options.id === entry.options.id).length !== 1) {
          continue
        }
        const declaration = declarations.find(item => item.entry === entry)?.declaration
        const fact = { id: entry.options.id, component: entry.options.name, service: declaration?.service || null, consumers: [], reason: '' }
        if (!declaration) {
          fact.reason = '实际加载实现缺少可核实的直接 Service 字面量声明（可能使用动态名称或中间继承）；未执行构造进行探测。'
        } else {
          const providerContext = entry.fiber.ctx
          const key = this.declarationScope(providerContext, declaration.service)
          const store = providerContext.reflect.store
          const peers = declarations.filter(item => item.declaration?.service === declaration.service && item.entry.fiber?.ctx?.root === providerContext.root && item.entry.fiber?.ctx?.reflect?.store === store && this.declarationScope(item.entry.fiber.ctx, declaration.service) === key)
          if (!key || peers.length !== 1 || providerContext.reflect._getImpl(declaration.service, false)) {
            fact.reason = '服务隔离作用域、唯一声明提供者或当前未注册状态未核实。'
          } else {
            fact.unregistered = true
            fact.source = 'loaded_constructor_declaration'
            fact.constructorDigest = createHash('sha256').update(declaration.sourceText).digest('hex')
            for (const candidate of failures) {
              const consumer = candidate.entry
              const context = consumer.fiber?.ctx
              if (candidate.outcome.kind === 'pending' && entries.filter(item => item.options.id === consumer.options.id).length === 1 && context?.root === providerContext.root && context?.reflect?.store === store && this.declarationScope(context, declaration.service) === key && Object.hasOwn(consumer.fiber.inject || {}, declaration.service) && !context.reflect._getImpl(declaration.service, false) && !consumer.fiber._store?.[declaration.service]) {
                fact.consumers.push({ id: consumer.options.id, component: consumer.options.name })
              }
            }
          }
        }
        result.push(fact)
      }
    } catch {
      return []
    }
    return result
  }

  audit(ctx, failures, required, bootstrap) {
    try {
      const nonce = process.env.DSH_X_DIAGNOSTIC_ATTEMPT
      if (!/^[a-f0-9]{32}$/.test(nonce || '')) {
        return
      }
      const snapshot = this.snapshot(ctx, failures, required, bootstrap)
      const candidates = snapshot.rows.filter(row => (row.firstSchemaFailure || row.importBeforeApply) && row.selected)
      if (candidates.length > MAX_CANDIDATES) {
        return
      }
      for (const row of candidates) {
        try {
          row.selected.contentDigest = packageFingerprint(row.selected.dir)
        } catch {
          row.firstSchemaFailure = false
          row.importBeforeApply = false
        }
      }
      this.rememberImportAudit(failures, snapshot)
      this.emit(snapshot)
    } catch {
      // 不加载插件、不改官方错误与恢复策略；缺证仅关闭此修复动作。
    }
  }
}

export const runtimeDiagnostics = new RuntimeDiagnostics()

/** 单项禁用只认可首次未执行的非必需叶子；等待者从不成为候选。 */
export function schemaDisableReason(observed, evidence) {
  if (evidence?.phase !== 'settled') {
    return '配置校验失败尚未经过本次启动审计。'
  }
  const dependencyReason = dependencyDisableReason(observed, evidence)
  if (dependencyReason) {
    return dependencyReason
  }
  if (observed?.state !== 'failed' || !observed.unique || !observed.topLevel || !observed.leaf) {
    return '未确认唯一顶层故障叶子条目。'
  }
  if (observed.required !== false) {
    return '目标为启动必需组件或必需性尚未核实，禁止自动禁用。'
  }
  if (!observed.firstSchemaFailure || observed.executions !== 0 || observed.descendants !== 0 || observed.ownedServices !== 0) {
    return '未证实首次配置校验失败且插件尚未执行，不能使用此单项禁用。'
  }
  return ''
}

/** 仅同一错误对象经过官方导入失败审计及致命退出时开放；模块顶层可能已有副作用。 */
export function importDisableReason(observed, evidence) {
  const dependencyReason = dependencyDisableReason(observed, evidence)
  if (dependencyReason) {
    return dependencyReason
  }
  if (observed?.state !== 'failed' || !observed.unique || !observed.topLevel || !observed.leaf) {
    return '未确认唯一顶层故障叶子条目。'
  }
  if (observed.required !== false || !['initializing', 'settled'].includes(evidence?.phase)) {
    return '目标为启动必需组件、必需性或证据阶段尚未核实，禁止自动禁用。'
  }
  if (!observed.fatalImport || !observed.importBeforeApply || observed.executions !== 0 || observed.descendants !== 0 || observed.ownedServices !== 0) {
    return '未确认致命错误与本次导入错误为同一对象，或插件 apply 已开始。'
  }
  return ''
}

function dependencyDisableReason(observed, evidence) {
  if (!['initializing', 'settled'].includes(evidence?.phase) || !Array.isArray(evidence.requiredDependencyChains)) {
    return '缺少本次观察阶段或实际服务依赖证据。'
  }
  if (evidence.requiredDependencyChains.some(chain => chain.targetId === observed?.id)) {
    return '已确认启动必需组件通过实际服务依赖目标，禁止单项禁用。'
  }
  return ''
}

/** 仅接受同一次spawn产生的有界旁路快照，不接收前端提供的修复目标。 */
export function readRuntimeEvidence(line, nonce) {
  if (!nonce || !line.startsWith(RUNTIME_EVIDENCE_PREFIX) || Buffer.byteLength(line) > MAX_BYTES) {
    return null
  }
  try {
    const parsed = JSON.parse(line.slice(RUNTIME_EVIDENCE_PREFIX.length))
    if (parsed.nonce !== nonce || !Array.isArray(parsed.rows) || parsed.rows.length > MAX_ENTRIES || !Array.isArray(parsed.requiredInactive) || parsed.requiredInactive.length > MAX_ENTRIES) {
      return null
    }
    if (parsed.rows.some(row => !row || typeof row.id !== 'string' || row.id.length > 128 || typeof row.component !== 'string' || row.component.length > 512) || parsed.requiredInactive.some(id => typeof id !== 'string' || id.length > 128)) {
      return null
    }
    if (parsed.requiredDependencyChains !== undefined && (!Array.isArray(parsed.requiredDependencyChains) || parsed.requiredDependencyChains.length > MAX_ENTRIES)) {
      return null
    }
    const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 128
    if (parsed.requiredDependencyChains?.some(chain => !chain || !validId(chain.requiredId) || !validId(chain.targetId) || !Array.isArray(chain.edges) || !chain.edges.length || chain.edges.length > MAX_DEPTH || chain.edges.some((edge, index) => !edge || !validId(edge.from) || !validId(edge.to) || !validId(edge.service) || edge.from !== (index ? chain.edges[index - 1].to : chain.requiredId)) || chain.edges.at(-1).to !== chain.targetId)) {
      return null
    }
    const declarationEvidence = []
    if (Array.isArray(parsed.declarationEvidence) && parsed.declarationEvidence.length <= MAX_CANDIDATES) {
      for (const item of parsed.declarationEvidence) {
        if (!item || !validId(item.id) || typeof item.component !== 'string' || item.component.length > 512 || (item.service !== null && !validId(item.service)) || (item.unregistered !== undefined && item.unregistered !== true) || (item.source !== undefined && item.source !== 'loaded_constructor_declaration') || (item.constructorDigest !== undefined && !/^[a-f0-9]{64}$/.test(item.constructorDigest)) || typeof item.reason !== 'string' || item.reason.length > 1024 || !Array.isArray(item.consumers) || item.consumers.length > MAX_ENTRIES || item.consumers.some(consumer => !consumer || !validId(consumer.id) || typeof consumer.component !== 'string' || consumer.component.length > 512)) {
          continue
        }
        if (item.unregistered === true && (!item.service || item.source !== 'loaded_constructor_declaration' || !item.constructorDigest || item.reason)) {
          continue
        }
        declarationEvidence.push({ id: item.id, component: item.component, service: item.service, reason: item.reason, ...(item.unregistered === true ? { unregistered: true, source: item.source, constructorDigest: item.constructorDigest } : {}), consumers: item.consumers.map(consumer => ({ id: consumer.id, component: consumer.component })) })
      }
    }
    for (const row of parsed.rows) {
      const config = row.configuration
      delete row.configuration
      if (!config || typeof config.field !== 'string' || config.field.length > 512 || ![true, false, null].includes(config.missing)) {
        continue
      }
      const environment = config.environment
      if (environment && (environment.field !== config.field || (environment.variable !== null && !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(environment.variable)) || ![true, false, null].includes(environment.present))) {
        continue
      }
      row.configuration = { field: config.field, missing: config.missing, environment: environment ? { field: config.field, variable: environment.variable, present: environment.present } : null }
    }
    return { ...(declarationEvidence.length ? { declarationEvidence } : {}), rows: parsed.rows, requiredInactive: parsed.requiredInactive, ...(parsed.phase ? { phase: parsed.phase } : {}), ...(parsed.requiredDependencyChains ? { requiredDependencyChains: parsed.requiredDependencyChains } : {}) }
  } catch {
    return null
  }
}
