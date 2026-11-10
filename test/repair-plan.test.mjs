import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { bindDiagnosis, checkedRepairPlan, createRepairPlan, profileFingerprint, validatePlanBinding } from '../src/repair-plan.js'

test('方案优先required与旧包，明确遥测非整体修复，不生成执行命令', () => {
  const plan = createRepairPlan({
    context: { profile: 'desktop', version: '2', clientVersionPresent: false },
    blockingChains: [{ id: 'connection', service: 'credentials', rejectedRow: { id: 'credentials', package: 'official@1' } }],
    rejected: [{ id: 'credentials', package: 'official@1', runtime: '2', source: 'unconfirmed' }],
    failed: [{ id: 'telemetry', package: 'telemetry', reason: 'serviceVersion missing' }],
    advice: [{ code: 'telemetry_configuration' }, { code: 'incompatible_packages' }],
  })
  assert.deepEqual(plan.steps.map(step => step.code), ['required_dependencies', 'align_packages', 'telemetry_configuration'])
  assert.match(JSON.stringify(plan), /未知|未确认/)
  assert.match(JSON.stringify(plan), /只读配置诊断/)
  assert.match(JSON.stringify(plan), /不推断其他功能已恢复/)
  assert.match(JSON.stringify(plan), /回退/)
  assert.equal(plan.execute, false)
  assert.ok(!JSON.stringify(plan).includes('command'))
  assert.ok(!JSON.stringify(plan).includes('npm install'))
})

test('指纹覆盖三配置且不读取凭据；缺失和变化可识别', () => {
  const home = mkdtempSync(join(tmpdir(), 'repair-plan-'))
  const profile = join(home, 'profiles', 'desktop')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'package.json'), '{}')
  const first = profileFingerprint(home, 'desktop')
  assert.ok(first.digest)
  writeFileSync(join(home, '.env'), 'SECRET=do-not-read')
  assert.equal(profileFingerprint(home, 'desktop').digest, first.digest)
  writeFileSync(join(home, 'cordis.patch.yml'), '[]')
  assert.notEqual(profileFingerprint(home, 'desktop').digest, first.digest)
  writeFileSync(join(profile, 'cordis.patch.yml'), 'x'.repeat(1024 * 1024 + 1))
  assert.equal(profileFingerprint(home, 'desktop').digest, null)
})

test('重启、配置、诊断、目标改变或指纹失败均不得标当前', () => {
  const current = { attemptId: 'attempt', diagnosisId: 'report', profileFingerprint: 'config', version: '2', profile: 'desktop', home: '/test', entry: '/boot', harnessEntry: '/runtime' }
  assert.equal(validatePlanBinding(current, current), true)
  for (const field of Object.keys(current)) {
    assert.equal(validatePlanBinding(current, { ...current, [field]: 'changed' }), false, field)
  }
  assert.equal(validatePlanBinding(current, null), false)
  assert.equal(validatePlanBinding({ ...current, profileFingerprint: null }, { ...current, profileFingerprint: null }), false)
})

test('skipped-only方案保留目标包与原因', () => {
  const plan = createRepairPlan({ skipped: { entries: [{ package: 'third-party', reason: 'incompatible with dsh 2' }] }, advice: [{ code: 'incompatible_packages' }] })
  assert.match(plan.evidence.join('\n'), /third-party.*incompatible/)
  assert.equal(plan.steps[0].code, 'align_packages')
})

test('生成期间发生配置变化，或文件不可读，均拒绝当前方案', () => {
  const home = mkdtempSync(join(tmpdir(), 'repair-plan-race-'))
  const profile = join(home, 'profiles', 'desktop')
  mkdirSync(profile, { recursive: true })
  const manifest = join(profile, 'package.json')
  writeFileSync(manifest, '{}')
  const diagnosis = { failed: [], advice: [] }
  const context = { attemptId: 'a'.repeat(32), version: '2', profile: 'desktop', home, entry: '/boot', harnessEntry: '/runtime', fingerprint: profileFingerprint(home, 'desktop') }
  const binding = bindDiagnosis(context, diagnosis)
  let calls = 0
  const lookup = () => {
    calls += 1
    if (calls === 2) {
      writeFileSync(manifest, '{}\n')
    }
    return { home, profile: 'desktop', binding, diagnosis }
  }
  assert.equal(checkedRepairPlan(binding, lookup).status, 409)
  mkdirSync(join(profile, 'cordis.patch.yml'))
  assert.equal(profileFingerprint(home, 'desktop').digest, null)
})

test('新证据未emit也使方案失效；stopping和runtime路径变化拒绝旧方案', () => {
  const source = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8')
  const begin = source.indexOf('function diagnosticForAttempt(')
  const end = source.indexOf('\nconst REPAIR_OBSERVATION_MS', begin)
  const diagnosticContext = { attemptId: 'a'.repeat(32), version: '2', profile: 'desktop', home: '/home', entry: '/boot', harnessEntry: '/runtime', fingerprint: { digest: 'config' } }
  let report = { failed: [], evidence: [] }
  const binding = bindDiagnosis(diagnosticContext, report)
  const warning = { ...diagnosticContext, binding, diagnosis: report }
  const proc = { ...diagnosticContext, diagnosticContext, diagnosticWarning: warning, status: 'running', diagnosis: { report: () => report } }
  let runtime = '/runtime'
  const sandbox = {
    instanceList: () => [proc], lastFailure: null, startingProfiles: new Set(), bindDiagnosis,
    launchScope: { run: (_, callback) => callback() }, bootEntry: () => '/boot', binPath: () => runtime,
  }
  vm.runInNewContext(source.slice(begin, end) + '\nthis.lookup = diagnosticForAttempt', sandbox)
  assert.equal(validatePlanBinding(binding, sandbox.lookup(binding.attemptId).binding), true)
  report = { failed: [], evidence: [{ text: 'new error' }] }
  assert.equal(validatePlanBinding(binding, sandbox.lookup(binding.attemptId).binding), false)
  proc.status = 'stopping'
  assert.equal(sandbox.lookup(binding.attemptId), null)
  proc.status = 'running'
  runtime = '/changed-runtime'
  assert.equal(sandbox.lookup(binding.attemptId), null)
})

test('方案轮询标记过期，旧异步响应不能覆盖新诊断，关闭清理timer', async () => {
  const html = readFileSync(new URL('../src/public/index.html', import.meta.url), 'utf8')
  const begin = html.indexOf('    const REPAIR_PLAN_CHECK_DELAY')
  const end = html.indexOf('    function notify(', begin)
  let response
  const pending = new Promise(resolve => { response = resolve })
  let checks = 0
  let cleared = 0
  const sandbox = {
    noticeEl: { hidden: false }, noticePlanEl: {}, noticeTitleEl: {}, noticeTextEl: {}, noticeCopyEl: {}, noticeDetailEl: { textContent: 'new diagnosis' },
    noticeCardsEl: { replaceChildren() {} },
    t: value => value,
    post: async () => pending,
    setTimeout: () => { checks += 1; return checks },
    clearTimeout: () => { cleared += 1 },
  }
  vm.runInNewContext(html.slice(begin, end) + '\nthis.configure = configureRepairPlan; this.verify = verifyRepairPlan; this.reset = resetRepairPlan; this.view = repairPlanView', sandbox)
  sandbox.configure({ binding: { profileFingerprint: 'config', attemptId: 'old' } })
  const old = sandbox.verify()
  sandbox.reset()
  sandbox.configure({ binding: { profileFingerprint: 'config', attemptId: 'new' } })
  response({ plan: { evidence: ['old plan'] } })
  await old
  assert.equal(sandbox.noticeDetailEl.textContent, 'new diagnosis')
  assert.equal(sandbox.view.binding.attemptId, 'new')
  sandbox.post = async () => ({ plan: { steps: [], evidence: [], scope: 'three files' } })
  await sandbox.verify()
  assert.equal(checks, 1)
  sandbox.post = async () => { throw new Error('stale') }
  await sandbox.verify(true)
  assert.match(sandbox.noticeDetailEl.textContent, /过期/)
  assert.equal(sandbox.view.binding, null)
  sandbox.reset()
  assert.ok(cleared > 0)
})

test('真实Escape绑定先清理方案再关闭弹窗', () => {
  const html = readFileSync(new URL('../src/public/index.html', import.meta.url), 'utf8')
  const begin = html.indexOf("    document.addEventListener('keydown', (event) => {", html.indexOf("confirmDialogEl.onclick"))
  const end = html.indexOf('    })', begin) + '    })'.length
  const calls = []
  let keydown
  const sandbox = {
    document: { addEventListener: (_, callback) => { keydown = callback } },
    noticeEl: { hidden: false },
    confirmDialogEl: { hidden: true },
    resetRepairPlan: () => calls.push('reset'),
    hideDialog: () => calls.push('hide'),
  }
  vm.runInNewContext(html.slice(begin, end), sandbox)
  keydown({ key: 'Escape' })
  assert.deepEqual(calls, ['reset', 'hide'])
})
