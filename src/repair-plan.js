import { createHash } from 'node:crypto'
import { closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'

const CONFIG_MAX_BYTES = 1024 * 1024
const BINDING_FIELDS = ['attemptId', 'diagnosisId', 'profileFingerprint', 'version', 'profile', 'home', 'entry', 'harnessEntry']

/** 只摘要官方实际读取的三配置，不读取凭据、会话或插件文件；失败仅禁止生成方案。 */
export function profileFingerprint(home, profile) {
  if (typeof home !== 'string' || typeof profile !== 'string' || !/^[\w.-]+$/.test(profile) || profile === '.' || profile === '..') {
    return { digest: null, error: 'invalid_target' }
  }
  const directory = join(home, 'profiles', profile)
  const files = [join(directory, 'package.json'), join(directory, 'cordis.patch.yml'), join(home, 'cordis.patch.yml')]
  const hash = createHash('sha256')
  for (const file of files) {
    let descriptor
    let observed = false
    try {
      const stat = lstatSync(file)
      observed = true
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > CONFIG_MAX_BYTES) {
        return { digest: null, error: 'unverifiable_config' }
      }
      descriptor = openSync(file, 'r')
      const opened = fstatSync(descriptor)
      if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size !== stat.size || opened.mtimeMs !== stat.mtimeMs || opened.ctimeMs !== stat.ctimeMs) {
        return { digest: null, error: 'changed_config' }
      }
      const bytes = Buffer.alloc(CONFIG_MAX_BYTES + 1)
      let length = 0
      while (length < bytes.length) {
        const count = readSync(descriptor, bytes, length, bytes.length - length, length)
        if (!count) {
          break
        }
        length += count
      }
      if (length > CONFIG_MAX_BYTES) {
        return { digest: null, error: 'oversized_config' }
      }
      const after = fstatSync(descriptor)
      const current = lstatSync(file)
      if ([after, current].some(item => item.ino !== stat.ino || item.dev !== stat.dev || item.size !== stat.size || item.mtimeMs !== stat.mtimeMs || item.ctimeMs !== stat.ctimeMs) || length !== stat.size) {
        return { digest: null, error: 'changed_config' }
      }
      hash.update(JSON.stringify([file, 'present', length, createHash('sha256').update(bytes.subarray(0, length)).digest('hex')]))
    } catch (error) {
      if (error.code === 'ENOENT' && !observed) {
        hash.update(JSON.stringify([file, 'missing']))
      } else {
        return { digest: null, error: 'unreadable_config' }
      }
    } finally {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor)
        } catch {
          // 文件句柄关闭失败不能改变原启动结果。
        }
      }
    }
  }
  return { digest: hash.digest('hex'), error: null }
}

/** 对照当前服务器证据，任何目标、启动轮次、配置或诊断变化都使旧方案失效。 */
export function validatePlanBinding(binding, current) {
  return Boolean(binding && current && BINDING_FIELDS.every(field =>
    typeof binding[field] === 'string' && binding[field].length > 0 && binding[field].length <= 4096 && binding[field] === current[field]))
}

/** 将报告绑定到启动前快照，不在用户点击时重新定义诊断基线。 */
export function bindDiagnosis(context, report) {
  return {
    attemptId: context.attemptId,
    version: context.version,
    profile: context.profile,
    home: context.home,
    entry: context.entry,
    harnessEntry: context.harnessEntry,
    profileFingerprint: context.fingerprint?.digest || null,
    diagnosisId: createHash('sha256').update(JSON.stringify(report)).digest('hex'),
  }
}

/** 生成和查看共用校验；只查服务器当前证据，配置读取失败时拒绝标为当前。 */
export function checkedRepairPlan(binding, lookup, language = 'zh', checkOnly = false) {
  const stale = { status: 409, body: { error: '诊断已过期或配置无法验证，请重新启动并查看最新诊断。', stale: true } }
  const before = lookup(binding?.attemptId)
  if (!before || !validatePlanBinding(binding, before.binding)) {
    return stale
  }
  const first = profileFingerprint(before.home, before.profile)
  if (!first.digest || first.digest !== binding.profileFingerprint) {
    return stale
  }
  const plan = checkOnly ? null : createRepairPlan(before.diagnosis, language)
  const after = lookup(binding.attemptId)
  const second = profileFingerprint(before.home, before.profile)
  if (!after || !validatePlanBinding(binding, after.binding) || !second.digest || second.digest !== first.digest) {
    return stale
  }
  return { status: 200, body: { binding: before.binding, valid: true, ...(plan ? { plan } : {}) } }
}

/** 纯生成可审阅方案；所有步骤均为建议，不产生命令或修改配置。 */
export function createRepairPlan(report = {}, language = 'zh') {
  const text = (chinese, english) => language === 'en' ? english : chinese
  const chains = (report.blockingChains || []).slice(0, 48)
  const rejected = (report.rejected || []).slice(0, 48)
  const evidence = [
    ...chains.map(chain => `${chain.id} (required) → ${chain.service}`),
    ...rejected.map(row => `${row.id}: ${row.package} / Harness ${row.runtime}`),
    ...(report.skipped?.entries || []).slice(0, 48).map(row => `${row.package}: ${row.reason}`),
    ...(report.failed || []).slice(0, 48).map(row => `${row.id}: ${row.reason}`),
  ]
  const unknown = [text('插件实际加载来源、兼容目标版本及同名行与服务的关系仍需确认。', 'Actual package source, compatible target version, and the relationship between same-name rows and services remain unconfirmed.')]
  const steps = []
  if (chains.length) {
    steps.push({
      code: 'required_dependencies',
      action: text('先核对必需插件等待的服务及其提供者；同名被拒绝项仅是线索，结合官方配置和实现确认关系。', 'First identify the services required plugins await and confirm their providers from configuration and implementation; a rejected row with the same name is only a clue.'),
      impact: text('仅调查阻塞链，不禁用必需插件或绕过版本检查。', 'Investigation only; do not disable required plugins or bypass version checks.'),
      rollback: text('此步骤只读，无需回退。', 'This step is read-only and needs no rollback.'),
      verify: text('确认每条必需依赖的提供者与被拒绝原因，不能仅凭包名推断。', 'Confirm each required dependency provider and rejection reason without inferring them from package names.'),
    })
  }
  if (rejected.length || (report.advice || []).some(item => item.code === 'incompatible_packages')) {
    steps.push({
      code: 'align_packages',
      action: text('确认实际解析路径和所属安装层，并查证兼容且不低于当前版本的升级候选；没有候选时仅说明缺失证据，有候选时保留回退副本并等待用户确认升级。来源未知时停止，不删除或直接禁用官方包。', 'Confirm actual resolution paths and installation layer, then verify a compatible upgrade that is not older than the current version. Without a candidate, report the missing evidence only. Preserve a rollback copy of that layer and wait for user confirmation of the upgrade. Stop when the source is unknown; do not delete or directly disable official packages.'),
      impact: text('真正对齐可能影响共享该层的其他 profile；修改前核对范围。此方案不会执行。', 'Actual alignment may affect other profiles sharing that layer; establish scope first. This plan executes nothing.'),
      rollback: text('记录原版本与精确路径，仅恢复已确认目标层的副本，不覆盖会话或凭据。', 'Record original versions and exact paths; restore only the confirmed layer copy, never sessions or credentials.'),
      verify: text('重新启动，逐项确认本次记录的版本拒绝与必需等待是否仍存在。', 'Restart and check whether each recorded version rejection and required dependency wait remains.'),
    })
  }
  if ((report.advice || []).some(item => item.code === 'telemetry_configuration')) {
    steps.push({
      code: 'telemetry_configuration',
      action: text('仅定位 serviceVersion 字段、定义文件及所引用的启动环境变量；无来源证据时明确未确认，不代填或改写。', 'Locate the serviceVersion field, its definition file and referenced environment variable. Report unknown sources without filling or rewriting values.'),
      impact: text('只读配置诊断，不执行修改；插件禁用或升级另经用户确认。', 'Read-only configuration diagnosis; plugin disable or upgrade requires separate confirmation.'),
      rollback: text('未修改配置，无需回退。', 'No configuration was changed.'),
      verify: text('按本次日志核对字段错误与启动环境是否存在，不推断其他功能已恢复。', 'Check the observed field error and captured launch environment without claiming other functions recovered.'),
    })
  }
  if (!steps.length) {
    unknown.push(text('当前证据不足以制定具体修改；保留诊断并补充插件来源及完整错误。', 'There is insufficient evidence for a specific change; retain diagnostics and establish package sources and complete errors.'))
  }
  return {
    execute: false,
    evidence,
    confirmed: evidence.length ? [text('以上条目由本次诊断直接记录；同名关联不是已证明的提供者关系。', 'The entries above are recorded by this diagnosis; same-name clues do not prove provider relationships.')] : [],
    unknown,
    steps,
    acceptance: [text('使用相同目标重启，确认 required 阻塞解除、拒绝项消失，并实际打开客户端；另测工作区与模型业务，本方案不保证这些业务已正常。', 'Restart the same target, confirm required dependencies activate and rejections disappear, then open the client. Workspace and model workflows require separate checks and are not guaranteed by this plan.')],
    scope: text('仅核对 profile/package.json、profile/cordis.patch.yml、home/cordis.patch.yml；插件文件替换等不属于完整环境指纹。', 'Freshness covers only profile/package.json, profile/cordis.patch.yml, and home/cordis.patch.yml; package-file replacements and other environment changes are not fully fingerprinted.'),
  }
}
