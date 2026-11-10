import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync, lstatSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { archivePackage, restorePackage, packageFingerprint } from '../src/diagnostic-repair.js'
import { DiagnosticRepairs, verificationSummary } from '../src/repair-actions.js'
import vm from 'node:vm'

function fixture() {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), 'diagnostic-repair-'))
  const source = join(root, 'profile/node_modules/@deepseek-ai/example')
  const backup = join(root, 'profile/.dsh-x-repairs/one/packages/@deepseek-ai/example')
  mkdirSync(source, { recursive: true })
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: '@deepseek-ai/example', version: '1.0.0' }))
  writeFileSync(join(source, 'index.js'), 'original')
  return { root, source, backup }
}

test('precise package archive preserves bytes and restores only into an absent target', () => {
  const item = fixture()
  const digest = packageFingerprint(item.source)
  archivePackage(item.source, item.backup, digest)
  assert.equal(existsSync(item.source), false)
  assert.equal(readFileSync(join(item.backup, 'index.js'), 'utf8'), 'original')
  restorePackage(item.source, item.backup, digest)
  assert.equal(packageFingerprint(item.source), digest)
  assert.equal(existsSync(item.backup), false)
})

test('content mutation invalidates preview even with unchanged package manifest', () => {
  const item = fixture()
  const digest = packageFingerprint(item.source)
  writeFileSync(join(item.source, 'index.js'), 'changed')
  assert.throws(() => archivePackage(item.source, item.backup, digest), /changed/)
  assert.equal(existsSync(item.backup), false)
})

test('rollback does not overwrite a new target or accept modified backup', () => {
  const item = fixture()
  const digest = packageFingerprint(item.source)
  archivePackage(item.source, item.backup, digest)
  mkdirSync(item.source, { recursive: true })
  assert.throws(() => restorePackage(item.source, item.backup, digest), /exists/)
  assert.equal(existsSync(item.backup), true)
  writeFileSync(join(item.backup, 'index.js'), 'changed')
  assert.throws(() => restorePackage(join(item.root, 'other'), item.backup, digest), /changed/)
})

test('dangling backup and restore targets are existing links, never missing targets', () => {
  const item = fixture()
  const digest = packageFingerprint(item.source)
  mkdirSync(join(item.root, 'profile/.dsh-x-repairs/one/packages/@deepseek-ai'), { recursive: true })
  symlinkSync(join(item.root, 'missing'), item.backup, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => archivePackage(item.source, item.backup, digest), /linked|exists/)
  assert.equal(lstatSync(item.backup).isSymbolicLink(), true)
  const restoreTarget = join(item.root, 'restore-target')
  symlinkSync(join(item.root, 'missing'), restoreTarget, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => restorePackage(restoreTarget, item.source, digest), /linked|exists/)
  assert.equal(lstatSync(restoreTarget).isSymbolicLink(), true)
})

test('fingerprints distinguish content containing former structural delimiters', () => {
  const first = fixture()
  const second = fixture()
  writeFileSync(join(first.source, 'index.js'), 'firstfile\0/z.js\0second')
  writeFileSync(join(second.source, 'index.js'), 'first')
  writeFileSync(join(second.source, 'z.js'), 'second')
  assert.notEqual(packageFingerprint(first.source), packageFingerprint(second.source))
})

test('failed revalidation preserves rollback history and a consumed confirmation cannot overwrite it', async () => {
  const item = fixture()
  const target = { home: item.root, profile: 'desktop', version: '1', harnessEntry: join(item.root, 'bin.js') }
  mkdirSync(join(item.root, 'profiles/desktop'), { recursive: true })
  const repairs = new DiagnosticRepairs({
    dataDir: () => join(item.root, 'data'),
    assertAvailable() {
    },
    async exclusive(target, operation) {
      return operation()
    },
    async stop() {
    },
    async verify() {
      throw new Error('verification failed')
    },
  })
  repairs.current = () => ({})
  repairs.inspect = async () => ({ fingerprint: 'same', adaptation: null, evidence: { version: '1', digest: 'proven-runtime' } })
  const id = 'a'.repeat(32)
  const backupRoot = join(item.root, 'profiles/desktop/.dsh-x-repairs', id)
  const action = { id: 'client-version', kind: 'client-version', source: repairs.adaptationPath(target), backup: join(backupRoot, 'adapter-before.json') }
  repairs.previews.set(id, { target, binding: {}, actions: [action], fingerprint: 'same', inspected: { adaptation: null, evidence: { digest: 'proven-runtime' } }, backupRoot, diagnosis: {} })
  await assert.rejects(repairs.execute(id, action.id), /不可执行/)
  assert.equal(repairs.history().length, 0)
  mkdirSync(backupRoot, { recursive: true })
  mkdirSync(join(item.root, 'data/diagnostic-repairs/adapters'), { recursive: true })
  writeFileSync(action.source, 'legacy-adapter')
  writeFileSync(action.backup, JSON.stringify({ previous: null }))
  repairs.save({ id, target, storageRoot: repairs.root(), action, status: 'applied_verification_failed', adapter: 'legacy-adapter', before: null })
  const restarted = new DiagnosticRepairs(repairs.options)
  restarted.versionEvidence = () => ({ version: '1', digest: 'proven-runtime' })
  restarted.options.verify = async () => {
    const pending = restarted.history().find(record => record.id === id)
    assert.equal(pending.outcome, null)
    assert.equal(pending.verificationStatus, 'pending')
    throw new Error('verification unavailable')
  }
  await assert.rejects(restarted.rollback(id), /verification unavailable/)
  assert.equal(restarted.history()[0].verificationStatus, 'failed')
  assert.equal(restarted.history()[0].outcome, null)
  assert.equal(restarted.history()[0].status, 'rolled_back')
  assert.equal(existsSync(action.source), false)
})

test('ready alone, exited process, waiting, skipped or truncated evidence never means resolved', () => {
  const clean = { failed: [], rejected: [], blockingChains: [], waiting: [], skipped: { entries: [] }, truncated: false }
  assert.equal(verificationSummary(true, true, clean).status, 'resolved')
  assert.equal(verificationSummary(true, false, clean).status, 'unresolved')
  assert.equal(verificationSummary(false, true, clean).status, 'unresolved')
  assert.equal(verificationSummary(true, true, null).status, 'unresolved')
  for (const field of ['failed', 'rejected', 'blockingChains', 'waiting']) {
    assert.equal(verificationSummary(true, true, { ...clean, [field]: [{}] }).status, 'unresolved')
  }
  assert.equal(verificationSummary(true, true, { ...clean, skipped: { entries: [{}] } }).status, 'unresolved')
  assert.equal(verificationSummary(true, true, { ...clean, truncated: true }).status, 'unresolved')
})

test('rollback precondition rejection preserves an earlier pending record and does not attach it to this error', async () => {
  const item = fixture()
  const target = { home: item.root, profile: 'desktop', version: '1', harnessEntry: join(item.root, 'bin.js') }
  const repairs = new DiagnosticRepairs({
    dataDir: () => join(item.root, 'data'),
    assertAvailable() {
      throw new Error('another operation owns the target')
    },
  })
  repairs.versionEvidence = () => ({ version: '1' })
  const id = 'e'.repeat(32)
  const profile = join(item.root, 'profiles/desktop')
  const action = { id: 'disable-optional', kind: 'disable-optional', source: join(profile, 'cordis.patch.yml'), backup: join(profile, '.dsh-x-repairs', id, 'patch-before.yml') }
  repairs.save({ id, target, storageRoot: repairs.root(), action, status: 'applied', verificationStatus: 'pending', outcome: null })
  const before = repairs.readRecord(id)
  await assert.rejects(repairs.rollback(id), error => {
    assert.match(error.message, /another operation/)
    assert.equal(error.repairRecord, undefined)
    return true
  })
  assert.deepEqual(repairs.readRecord(id), before)
})

test('unknown actions and changed preview fingerprint cannot stop or mutate the target', async () => {
  const item = fixture()
  let stops = 0
  const repairs = new DiagnosticRepairs({
    dataDir: () => join(item.root, 'data'),
    assertAvailable() {
    },
    async stop() {
      stops += 1
    },
    async exclusive(target, operation) {
      return operation()
    },
  })
  repairs.current = () => ({})
  repairs.inspect = async () => ({ fingerprint: 'changed' })
  const id = 'b'.repeat(32)
  const target = { home: item.root, profile: 'desktop', version: '1', harnessEntry: 'runtime' }
  const action = { id: 'unknown', disabledReason: 'unknown source' }
  repairs.previews.set(id, { target, binding: {}, actions: [action], inspected: {}, fingerprint: 'original' })
  await assert.rejects(repairs.execute(id, action.id), /不可执行/)
  action.disabledReason = ''
  await assert.rejects(repairs.execute(id, action.id), /不可执行/)
  action.kind = 'package'
  await assert.rejects(repairs.execute(id, action.id), /内容已变化/)
  assert.equal(stops, 0)
  assert.equal(repairs.history().length, 0)
})

test('production exclusive rechecks a competing startup before acquiring maintenance ownership', async () => {
  const source = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8')
  const begin = source.indexOf('const REPAIR_OBSERVATION_MS')
  const end = source.indexOf('\n/**', begin)
  const key = '/isolated\0desktop'
  const context = {
    DiagnosticRepairs: class {
      constructor(options) {
        this.options = options
      }
    },
    diagnosticForAttempt() {
    },
    binPath: () => '/runtime', startingProfiles: new Set([key]), maintainingProfiles: new Set(),
    pluginBusy: false, syncRunning: false, packInstalling: false, optimizingVersion: null,
    instanceList: () => [],
  }
  vm.runInNewContext(source.slice(begin, end) + '\nthis.controller = diagnosticRepairs', context)
  let operated = false
  await assert.rejects(context.controller.options.exclusive({ home: '/isolated', profile: 'desktop', harnessEntry: '/runtime' }, async () => {
    operated = true
  }), /正在启动/)
  assert.equal(operated, false)
  assert.equal(context.maintainingProfiles.size, 0)
})

test('repair confirmation Escape cancels the child and preserves its diagnostic parent', () => {
  const html = readFileSync(new URL('../src/public/index.html', import.meta.url), 'utf8')
  const begin = html.indexOf("    document.addEventListener('keydown', (event) => {", html.indexOf('confirmDialogEl.onclick'))
  const end = html.indexOf('    })', begin) + '    })'.length
  const calls = []
  let keydown
  vm.runInNewContext(html.slice(begin, end), {
    document: {
      addEventListener: (_, callback) => {
        keydown = callback
      },
    },
    noticeEl: { hidden: false }, confirmDialogEl: { hidden: false },
    settleConfirm: value => calls.push(['confirm', value]),
    resetRepairPlan: () => calls.push('reset'), hideDialog: () => calls.push('hide'),
  })
  keydown({ key: 'Escape' })
  assert.deepEqual(calls, [['confirm', false]])
  assert.match(html, /showPackDialog\(confirmDialogEl, null, parent\)/)
  assert.match(html, /await hidePackDialog\(confirmDialogEl\)/)
})

test('ordinary launch no longer reads saved adapters', () => {
  assert.equal(DiagnosticRepairs.prototype.launchEnvironment, undefined)
})

test('repair labels do not invent causes and proposals use supplied structured steps', () => {
  const html = readFileSync(new URL('../src/public/index.html', import.meta.url), 'utf8')
  const begin = html.indexOf('    function repairLabel(')
  const end = html.indexOf('    async function showRepairCards', begin)
  const context = { t: value => value }
  vm.runInNewContext(html.slice(begin, end) + '\nthis.present = repairPresentation; this.waitingProvider = waitingProviderText', context)
  const action = { component: '@deepseek-ai/dsh-credentials-local', kind: 'package', cause: 'unverified story', solution: { steps: [{ operation: 'archive_package', beforeVersion: '1.0.0', afterVersion: '2.0.0' }] } }
  const view = context.present(action)
  assert.equal(view.title, '账号与密钥读取')
  assert.equal(view.cause, undefined)
  assert.match(view.recommendation, /1.0.0 → 2.0.0/)
  const unavailable = context.present({ ...action, disabledReason: 'required dependency' })
  assert.equal(unavailable.recommendation, '当前证据不满足操作条件，不能执行此方案。')
  assert.doesNotMatch(html, /与上方故障的完整因果关系/)
  const preview = { runtimeState: { requiredDependencyChains: [{ edges: [{ from: 'consumer-a', service: 'same-name', to: 'provider-a' }] }] } }
  assert.equal(context.waitingProvider(preview, 'same-name', { id: 'consumer-a' }), 'provider-a')
  assert.equal(context.waitingProvider(preview, 'same-name', { id: 'consumer-b' }), '尚未核实')
  const unknown = context.present({ component: '@deepseek-ai/dsh-host-product-telemetry-otel', kind: 'client-version' })
  assert.equal(unknown.recommendation, '尚无已确认方案')
  assert.doesNotMatch(JSON.stringify(unknown), /serviceVersion|主因|残留/)
})

test('repair version selection rejects downgrade and unreliable semver comparisons', async () => {
  const { compatibleUpgrade } = await import('../src/diagnostic-repair.js')
  assert.equal(compatibleUpgrade('0.1.1-rc.2', '0.2.1-rc.2'), true)
  assert.equal(compatibleUpgrade('1.0.0-rc.9', '1.0.0-rc.10'), true)
  assert.equal(compatibleUpgrade('1.0.0', '1.0.0'), true)
  for (const [current, target] of [
    ['2.0.0', '1.0.0'], ['1.0.0', '1.0.0-rc.1'],
    ['1.0', '1.1.0'], ['01.0.0', '2.0.0'],
    ['1.0.0-01', '1.0.0-2'], ['1.0.0-9007199254740992', '1.0.0-9007199254740993'],
    ['9007199254740992.0.0', '9007199254740993.0.0'], ['unknown', '2.0.0'],
  ]) {
    assert.equal(compatibleUpgrade(current, target), false, `${current} -> ${target}`)
  }
})

test('confirmed optional group preserves exact patch bytes, rejects conflict and rolls back after manager restart', async () => {
  const item = fixture()
  const target = { home: item.root, profile: 'desktop', version: '1.0.0', harnessEntry: join(item.root, 'bin.js') }
  const profile = join(item.root, 'profiles/desktop')
  mkdirSync(profile, { recursive: true })
  const source = join(profile, 'cordis.patch.yml')
  const original = '# retain bytes\r\n[]\r\n'
  writeFileSync(source, original)
  const repairs = new DiagnosticRepairs({
    dataDir: () => join(item.root, 'data'),
    assertAvailable() {
    },
    async exclusive(target, operation) {
      return operation()
    },
    async stop() {
    },
    async verify() {
      return { status: 'resolved', remaining: { failed: 0, rejected: 0, required: 0, waiting: 0, skipped: 0 } }
    },
  })
  repairs.current = () => ({})
  repairs.inspect = async () => ({ fingerprint: 'same', adaptation: null, disableAllowed: true })
  const id = 'd'.repeat(32)
  const backupRoot = join(profile, '.dsh-x-repairs', id)
  const action = { id: 'disable-analytics', kind: 'disable-optional', source, backup: join(backupRoot, 'patch-before.yml') }
  repairs.previews.set(id, { target, binding: {}, actions: [action], fingerprint: 'same', inspected: {}, backupRoot, diagnosis: {} })
  const record = await repairs.execute(id, action.id)
  assert.equal(record.outcome.bypassed, true)
  assert.equal(readFileSync(action.backup, 'utf8'), original)
  assert.match(readFileSync(source, 'utf8'), /- id: desktop-product-telemetry\n  disabled: true/)
  assert.match(readFileSync(source, 'utf8'), /- id: product-analytics\n  disabled: true/)
  const restarted = new DiagnosticRepairs(repairs.options)
  restarted.versionEvidence = () => ({ version: target.version })
  const applied = readFileSync(source, 'utf8')
  writeFileSync(source, applied + '# user changed\n')
  await assert.rejects(restarted.rollback(id), /变化/)
  writeFileSync(source, applied)
  await restarted.rollback(id)
  assert.equal(readFileSync(source, 'utf8'), original)
  assert.equal(restarted.history()[0].status, 'rolled_back')
})

test('runtime-confirmed single row disable preserves bad config and never selects waiting rows', async () => {
  const item = fixture()
  const target = { home: item.root, profile: 'desktop', version: '1.0.0', harnessEntry: join(item.root, 'bin.js') }
  const profile = join(item.root, 'profiles/desktop')
  mkdirSync(profile, { recursive: true })
  const source = join(profile, 'cordis.patch.yml')
  const original = '- id: fault\n  config:\n    path: 42\n'
  writeFileSync(source, original)
  let stopped = 0
  const repairs = new DiagnosticRepairs({
    dataDir: () => join(item.root, 'data'),
    assertAvailable() {
    },
    async exclusive(target, operation) {
      return operation()
    },
    async stop() {
      stopped += 1
    },
    async verify() {
      return { status: 'unresolved', remaining: { failed: 0, rejected: 0, required: 0, waiting: 1, skipped: 0 } }
    },
  })
  const id = 'e'.repeat(32)
  const backupRoot = join(profile, '.dsh-x-repairs', id)
  const action = { id: 'disable-row:fault', kind: 'disable-optional', proof: 'runtime-schema-leaf', component: 'example', rows: ['fault'], source, backup: join(backupRoot, 'patch-before.yml') }
  const diagnosis = { failed: [{}], rejected: [], blockingChains: [], waiting: [{ id: 'waiter' }], skipped: { entries: [] } }
  const preview = { target, binding: {}, actions: [action], fingerprint: 'same', inspected: {}, backupRoot, diagnosis }
  repairs.current = () => ({})
  repairs.inspect = async () => ({ fingerprint: 'same', disableCandidates: [{ id: 'fault', component: 'example', disabledReason: '' }] })
  repairs.previews.set(id, preview)
  const record = await repairs.execute(id, action.id)
  assert.equal(record.outcome.status, 'partial')
  assert.match(readFileSync(source, 'utf8'), /path: 42/)
  assert.match(readFileSync(source, 'utf8'), /id: fault\n  disabled: true/)
  assert.doesNotMatch(readFileSync(source, 'utf8'), /waiter|desktop-product-telemetry|product-analytics/)
  assert.deepEqual(record.actualChanges.at(-1).rows, ['fault'])
  repairs.versionEvidence = () => ({ version: target.version })
  await repairs.rollback(id)
  assert.equal(readFileSync(source, 'utf8'), original)
  const anotherId = 'f'.repeat(32)
  repairs.previews.set(anotherId, { ...preview, backupRoot: join(profile, '.dsh-x-repairs', anotherId) })
  repairs.inspect = async () => ({ fingerprint: 'changed', disableCandidates: [] })
  const before = stopped
  await assert.rejects(repairs.execute(anotherId, action.id), /变化/)
  assert.equal(stopped, before)
  assert.equal(readFileSync(source, 'utf8'), original)
})

test('optional proof fingerprints files without service references, and rejects later changes', async () => {
  const { optionalAnalyticsProof } = await import('../src/optional-analytics-proof.js')
  const item = fixture()
  const modules = join(item.root, 'runtime')
  const packageDir = join(modules, '@deepseek-ai/example')
  mkdirSync(join(packageDir, 'lib'), { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), '{"name":"example"}')
  writeFileSync(join(packageDir, 'lib/plain.js'), 'export const value = 1')
  const before = optionalAnalyticsProof(modules)
  writeFileSync(join(packageDir, 'lib/plain.js'), 'export const value = 2')
  const after = optionalAnalyticsProof(modules)
  assert.notEqual(before.fingerprint, after.fingerprint)
  assert.equal(after.allowed, false)
})

test('optional patch rollback resumes after either rename boundary without overwriting new content', async () => {
  const { renameSync } = await import('node:fs')
  for (const interruptedRollback of [false, true]) {
    const item = fixture()
    const target = { home: item.root, profile: 'desktop', version: '1.0.0', harnessEntry: '/runtime' }
    const id = (interruptedRollback ? 'e' : 'f').repeat(32)
    const profile = join(item.root, 'profiles/desktop')
    const backupRoot = join(profile, '.dsh-x-repairs', id)
    mkdirSync(backupRoot, { recursive: true })
    const source = join(profile, 'cordis.patch.yml')
    const backup = join(backupRoot, 'patch-before.yml')
    const original = '[]\r\n'
    const applied = '- id: desktop-product-telemetry\n  disabled: true\n'
    const { createHash } = await import('node:crypto')
    const hash = value => createHash('sha256').update(value).digest('hex')
    writeFileSync(backup, original)
    if (interruptedRollback) {
      writeFileSync(source, applied)
      renameSync(source, join(backupRoot, 'patch-withdrawn.yml'))
    }
    const repairs = new DiagnosticRepairs({
      dataDir: () => join(item.root, 'data'),
      assertAvailable() {
      },
      async exclusive(target, operation) {
        return operation()
      },
      async stop() {
      },
      async verify() {
        return { status: 'unresolved' }
      },
    })
    repairs.versionEvidence = () => ({ version: target.version })
    repairs.save({ id, at: Date.now(), storageRoot: repairs.root(), target, status: 'interrupted', action: { kind: 'disable-optional', source, backup }, patchBeforeDigest: hash(original), patchAppliedDigest: hash(applied) })
    await repairs.rollback(id)
    assert.equal(readFileSync(source, 'utf8'), original)
  }
})

test('one component renders one fault card with two adjacent alternatives and unchanged action IDs', () => {
  const html = readFileSync(new URL('../src/public/index.html', import.meta.url), 'utf8')
  assert.match(html, /function renderRepairActionGroups/)
  class Element {
    constructor(tag) {
      this.tag = tag
      this.children = []
      this.style = {}
      this.textContent = ''
    }
    append(...children) {
      this.children.push(...children)
    }
  }
  const calls = []
  const context = {
    t: value => value,
    document: {
      createElement: tag => new Element(tag),
      createTextNode: value => ({ textContent: value }),
    },
    executeRepair: (preview, action) => {
      calls.push(action.id)
    },
  }
  const begin = html.indexOf('    function cardLine(')
  const end = html.indexOf('    async function showRepairCards', begin)
  vm.runInNewContext(html.slice(begin, end) + '\nthis.render = renderRepairActionGroups; this.observation = observationText; this.confirmation = confirmationText', context)
  assert.equal(context.observation({ field: 'serviceVersion', reason: 'ValidationError: raw details' }), '配置校验失败：serviceVersion 缺少必填值')
  assert.equal(context.observation({ field: 'path', validation: { kind: 'type', expected: 'string' }, reason: 'ValidationError: raw details' }), '配置校验失败：path 类型不符合要求（string）')
  assert.equal(context.confirmation({ kind: 'configuration_source', field: 'serviceVersion', path: '/verified/template.yml', line: 54, missing: true, fieldDeclared: true, environment: { variable: 'DSH_CLIENT_VERSION', present: false } }), 'serviceVersion ← process.env.DSH_CLIENT_VERSION · 校验时缺值 · 当前有效配置来源：/verified/template.yml:54')
  for (const [present, expected] of [[true, '已传入'], [false, '未传入'], [undefined, '是否传入未记录']]) {
    assert.equal(context.confirmation({ kind: 'launch_variable_presence', source: 'captured_spawn_environment', variable: 'DSH_CLIENT_VERSION', present }), `本次启动：DSH_CLIENT_VERSION ${expected}`)
  }
  const actions = [
    { id: 'client-version', kind: 'client-version', component: '@deepseek-ai/dsh-host-product-telemetry-otel' },
    { id: 'disable-analytics', kind: 'disable-optional', component: '@deepseek-ai/dsh-host-product-telemetry-otel' },
  ]
  for (const action of actions) {
    action.problem = { dependencies: [{ from: { component: '@deepseek-ai/dsh-client-product-analytics' }, to: { component: '@deepseek-ai/dsh-host-product-telemetry-otel' }, service: 'productTelemetry' }], waiting: [{ service: 'sessionQuery', consumers: [{ id: 'session-reference', required: null }, { id: 'session-controller', required: true }] }] }
  }
  const cards = context.render({ actions }, 1)
  assert.equal(cards.length, 1)
  const nodes = []
  function visit(node) {
    nodes.push(node)
    for (const child of node.children || []) {
      visit(child)
    }
  }
  visit(cards[0])
  assert.equal(nodes.filter(node => node.tag === 'h3').length, 1)
  assert.equal(nodes.filter(node => node.tag === 'button').length, 2)
  assert.ok(nodes.some(node => node.textContent.includes('本卡可直接执行 2')))
  assert.ok(!nodes.some(node => node.textContent.includes('二选一')))
  assert.ok(nodes.some(node => node.textContent === '禁用这些插件'))
  assert.ok(!nodes.some(node => node.textContent.includes('禁用以恢复使用')))
  assert.ok(nodes.some(node => node.textContent.includes('产品使用情况收集 → 产品运行情况上报')))
  assert.ok(!nodes.some(node => node.textContent.includes('sessionQuery')))
  assert.ok(nodes.some(node => node.style?.display === 'grid' || node.className === 'rc-options multi'), '多方案并排的容器（现在是 rc-options.multi 类）')
  for (const button of nodes.filter(node => node.tag === 'button')) {
    button.onclick()
  }
  assert.deepEqual(calls, ['client-version', 'disable-analytics'])
})

test('repair routes publish final history before success or failure response, but previews do not publish', async () => {
  const source = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8')
  const begin = source.indexOf("  if (req.method === 'POST' && ['/api/diagnosis/repair/preview'")
  const end = source.indexOf("  if (req.method === 'POST' && ['/api/diagnosis/plan'", begin)
  for (const route of ['preview', 'execute', 'rollback']) {
    for (const failed of [false, true]) {
      const calls = []
      const operation = async () => {
        calls.push('saved-final-record')
        if (failed) {
          throw new Error('operation failed')
        }
        return { outcome: { status: 'resolved' } }
      }
      await vm.runInNewContext('(async () => {' + source.slice(begin, end) + '})()', {
        req: { method: 'POST' }, url: { pathname: '/api/diagnosis/repair/' + route }, body: {}, res: {},
        diagnosticRepairs: { preview: operation, execute: operation, rollback: operation },
        publicFailure: value => value,
        emitState: async () => {
          calls.push('published-final-history')
        },
        send: (response, status) => {
          calls.push('response-' + status)
        },
      })
      assert.deepEqual(calls, route === 'preview' ? ['saved-final-record', failed ? 'response-409' : 'response-200'] : ['saved-final-record', 'published-final-history', failed ? 'response-409' : 'response-200'])
    }
  }
})
