import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import vm from 'node:vm'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const fixture = readFileSync(new URL('./fixtures/startup-desktop-sanitized.txt', import.meta.url), 'utf8')
const html = readFileSync(join(ROOT, 'src', 'public/index.html'), 'utf8')

function write(file, content) {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, content)
}

async function freePort() {
  const probe = createServer()
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  return port
}

test('脱敏故障样例通过 reserved 启动入口、子进程管道、失败 API 和原弹窗回放', async () => {
  const box = mkdtempSync(join(tmpdir(), 'diagnosis-replay-'))
  const home = join(box, 'home')
  const appdata = join(box, 'appdata')
  const data = join(box, 'data')
  const version = '9.9.9'
  const packages = join(data, 'versions', version, 'node_modules/@deepseek-ai')
  const cli = join(packages, 'dsh/lib/bin.js')
  write(cli, 'process.exitCode = 1')
  write(join(packages, 'dsh/package.json'), JSON.stringify({ type: 'module', exports: { './profile-boot': './lib/profile-boot.js' } }))
  write(join(packages, 'dsh-app-boot/package.json'), JSON.stringify({ type: 'module', main: 'index.js' }))
  write(join(packages, 'dsh-app-boot/index.js'), 'export function loadLayeredEnv() { return {} }')
  // 同一脱敏日志经管道拆成 UTF-8 小块；噪音让错误离开原来的 120 行尾部。
  const replay = `${fixture}\n${Array.from({ length: 350 }, (_, index) => `ordinary-${index}`).join('\n')}\n最后一行🙂 sk-abcdefghijklmnop`
  write(join(packages, 'dsh/lib/profile-boot.js'), `
export async function runProfile() {
  const bytes = Buffer.from(${JSON.stringify(replay)})
  for (let offset = 0; offset < bytes.length; offset += 137) {
    if (!process.stderr.write(bytes.subarray(offset, offset + 137))) {
      await new Promise(resolve => process.stderr.once('drain', resolve))
    }
    await new Promise(resolve => setImmediate(resolve))
  }
  process.exitCode = 1
}
`)
  write(join(home, 'profiles/desktop/package.json'), JSON.stringify({ dsh: { bundles: [] } }))
  const settings = JSON.stringify({ dataDir: data, dshHome: home, seedMarket: false, autoDisablePlugins: false, downloadSource: 'official', proxyMode: 'off' })
  write(join(appdata, 'DSH/settings.json'), settings)
  write(join(home, 'Library/Application Support/DSH/settings.json'), settings)
  // Linux 的每用户目录是 $XDG_CONFIG_HOME/DSH，默认 $HOME/.config/DSH
  write(join(home, '.config/DSH/settings.json'), settings)
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const manager = spawn(process.execPath, [join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port), APPDATA: appdata, LOCALAPPDATA: join(box, 'local'),
      HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), DSH_HOME: home, DSH_CLIENT_VERSION: '',
    },
    stdio: 'ignore',
    windowsHide: true,
  })
  try {
    let ready = false
    for (let attempt = 0; attempt < 100 && !ready; attempt += 1) {
      ready = await fetch(`${origin}/api/ping`).then(response => response.ok, () => false)
      if (!ready) {
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
    assert.ok(ready)
    const response = await fetch(`${origin}/api/start`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version, profile: 'desktop' }),
    })
    assert.equal(response.status, 500)
    const { failure } = await response.json()
    const report = failure.diagnosis
    assert.equal(report.failed.length, 1)
    assert.match(report.failed[0].reason, /serviceVersion missing required value/)
    assert.equal(report.waiting.length, 32)
    assert.equal(report.rejected.length, 11)
    assert.equal(report.skipped.entries.length, 3)
    assert.ok(failure.binding.attemptId)
    const planRequest = async (binding, check = false) => fetch(`${origin}/api/diagnosis/plan${check ? '/check' : ''}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ binding }),
    })
    const profileManifest = join(home, 'profiles/desktop/package.json')
    const originalManifest = readFileSync(profileManifest, 'utf8')
    const generated = await planRequest(failure.binding)
    assert.equal(generated.status, 200)
    assert.equal((await generated.json()).plan.execute, false)
    assert.equal(readFileSync(profileManifest, 'utf8'), originalManifest, '生成方案不得写配置')
    assert.equal((await planRequest({ ...failure.binding, home: '/other' })).status, 409)
    write(profileManifest, originalManifest + '\n')
    assert.equal((await planRequest(failure.binding, true)).status, 409, '外部配置变化使已生成方案过期')
    assert.equal((await planRequest(failure.binding)).status, 409, '不能将点击时配置重新认作诊断基线')
    write(profileManifest, originalManifest)
    assert.equal(report.context.entry, join(ROOT, 'src', 'reserved-profile-boot.mjs'))
    assert.equal(report.context.harnessEntry, cli)
    assert.equal(report.context.clientVersionPresent, false)
    assert.ok(!failure.tail.some(line => line.includes('serviceVersion')))
    assert.ok(failure.tail.some(line => line.includes('最后一行🙂 sk-***')))
    assert.ok(!JSON.stringify(failure).includes('sk-abcdefghijklmnop'))
    const state = await fetch(`${origin}/api/state`).then(result => result.json())
    assert.deepEqual(state.failure.diagnosis, report)
    let shown
    let structured = null
    const begin = html.indexOf('    function failureText(')
    const end = html.indexOf('    function cardLine(', begin)
    const context = {
      t: (text, values = {}) => text.replace(/\{(\w+)\}/g, (_, name) => values[name] ?? name),
      notify: (...args) => { shown = args },
      renderDiagnosis: (report) => { structured = report },
      configureRepairPlan() {},
      showRepairCards() {},
    }
    vm.runInNewContext(html.slice(begin, end) + '\nthis.showFailure = showFailure; this.diagnosisText = diagnosisText', context)
    context.showFailure(failure)
    // 弹窗里诊断走结构化渲染（renderDiagnosis），纯文本版 diagnosisText 供剪贴板；两份内容都要在
    assert.equal(structured, failure.diagnosis, '结构化展示拿到的就是这份报告')
    assert.equal(shown[2], (failure.tail || []).join('\n'), 'pre 里只剩原始输出')
    const rendered = context.diagnosisText(failure.diagnosis)
    assert.match(rendered, /直接失败 \(1\)/)
    assert.match(rendered, /受影响项，不等于根因.*\(32\)/)
    assert.match(rendered, /DSH_CLIENT_VERSION/)
    assert.match(rendered, /修复建议（不会自动执行）/)
    assert.match(rendered, /serviceVersion missing required value/)
    assert.match(rendered, /\[example-addon\].*scope\.settings\.register is not a function/)
    assert.equal(readFileSync(join(home, 'profiles/desktop/package.json'), 'utf8'), JSON.stringify({ dsh: { bundles: [] } }))
    write(join(packages, 'dsh/lib/profile-boot.js'), `
export async function runProfile() {
  console.error('Error: unrelated second attempt')
  process.exitCode = 1
}
`)
    const retry = await fetch(`${origin}/api/start`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version, profile: 'desktop' }),
    }).then(result => result.json())
    assert.equal(retry.failure.diagnosis.failed.length, 0)
    assert.equal(retry.failure.diagnosis.waiting.length, 0)
    assert.equal(retry.failure.diagnosis.rejected.length, 0)
    assert.equal(retry.failure.diagnosis.skipped.entries.length, 0)
    assert.equal((await planRequest(failure.binding, true)).status, 409, '重启后旧轮次的方案过期')
    // 接着启动另一组合：没有本次故障的前置失败，不能继承报告。
    const next = await fetch(`${origin}/api/start`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: '8.8.8', profile: 'web' }),
    }).then(result => result.json())
    assert.equal(next.failure.diagnosis, undefined)
  } finally {
    const closed = new Promise(resolve => manager.once('exit', resolve))
    manager.kill()
    await closed
  }
})
