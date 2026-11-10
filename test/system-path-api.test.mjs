import assert from 'node:assert/strict'
import childProcess, { spawn } from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import test from 'node:test'
import { isolateUserHome } from './isolated-home.mjs'

test('Windows PATH API：开启生成可用入口，重复开关与无已安装版本不报错', { skip: process.platform !== 'win32', timeout: 20000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh windows path-'))
  const app = isolateUserHome(root)
  // npm test 会注入全局 prefix；发现系统 dsh 的各个入口也要隔离，才能稳定覆盖「尚未安装」。
  for (const key of ['LOCALAPPDATA', 'npm_config_prefix', 'ProgramW6432', 'ProgramFiles', 'ProgramFiles(x86)']) {
    process.env[key] = join(root, 'system')
  }
  const dataDir = join(root, 'data')
  const settingsFile = join(app, 'settings.json')
  await mkdir(app, { recursive: true })
  await mkdir(dataDir, { recursive: true })
  await writeFile(settingsFile, JSON.stringify({ dataDir, dshHome: join(root, '.dsh'), systemPath: false, seedMarket: false }))
  process.env.DSH_VERSIONS_DATA = dataDir
  process.env.PORT = String(await new Promise((resolve, reject) => {
    const probe = createServer().on('error', reject).listen(0, '127.0.0.1', () => {
      const port = probe.address().port
      probe.close(() => resolve(port))
    })
  }))

  // 只替换注册表边界，HTTP、设置落盘和命令入口都走真实代码，避免测试改到用户 PATH。
  const originalSpawnSync = childProcess.spawnSync
  let userPath = 'C:\\existing-tools'
  let registryWritable = true
  t.mock.method(childProcess, 'spawnSync', (command, args, options) => {
    if (command !== 'reg') return originalSpawnSync(command, args, options)
    assert.equal(args[1], 'HKCU\\Environment')
    if (args[0] === 'query') return { status: 0, stdout: `    Path    REG_EXPAND_SZ    ${userPath}\r\n` }
    assert.equal(args[0], 'add')
    if (!registryWritable) return { status: 1, stdout: '' }
    userPath = args[args.indexOf('/d') + 1]
    return { status: 0, stdout: '' }
  })
  syncBuiltinESMExports()
  let manager
  t.after(async () => {
    await manager?.stopAll()
    t.mock.restoreAll()
    syncBuiltinESMExports()
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })
  manager = await import('../src/server.js')
  const origin = await manager.startServer()
  const binDir = manager.systemBinDir()
  async function call(enabled) {
    const res = await fetch(`${origin}/api/settings`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ systemPath: enabled }), signal: AbortSignal.timeout(3000),
    })
    const body = await res.json()
    assert.equal(res.status, 200, JSON.stringify(body))
    assert.equal(body.systemPath, enabled)
    assert.equal(body.systemPathMode, 'automatic')
    assert.equal(JSON.parse(await readFile(settingsFile, 'utf8')).systemPath, enabled)
    return body
  }

  assert.equal((await call(true)).systemPathResult.ok, true, '尚未安装版本也能保存开关')
  assert.equal(userPath, `C:\\existing-tools;${binDir}`)
  await assert.rejects(readFile(join(binDir, 'dsh.cmd')), { code: 'ENOENT' })
  const versions = ['0.1.8', '0.1.7']
  for (const version of versions) {
    const lib = join(dataDir, 'versions', version, 'node_modules', '@deepseek-ai', 'dsh', 'lib')
    await mkdir(lib, { recursive: true })
    await writeFile(join(lib, 'bin.js'), `
if (process.argv.includes('--version')) console.log(${JSON.stringify(version)})
else {
  const { createServer } = await import('node:http')
  const server = createServer((req, res) => res.end('<!doctype html><html><body>fixture</body></html>'))
  server.listen(0, '127.0.0.1', () => console.log('dsh web: http://127.0.0.1:' + server.address().port + '/?token=fixture'))
}
`)
  }
  await writeFile(join(dataDir, 'config.json'), JSON.stringify({ versions }))
  for (const enabled of [true, true, false, false, true]) {
    assert.equal((await call(enabled)).systemPathResult.ok, true)
    assert.equal(userPath, enabled ? `C:\\existing-tools;${binDir}` : 'C:\\existing-tools')
  }
  const shim = await readFile(join(binDir, 'dsh.cmd'), 'utf8')
  assert.ok(shim.includes(join(dataDir, 'versions', versions[0])), '无运行实例时使用安装列表首个版本')
  const execution = originalSpawnSync('cmd.exe', ['/d', '/c', 'dsh --version'], {
    cwd: binDir, encoding: 'utf8', windowsHide: true,
  })
  assert.equal(execution.status, 0, execution.stderr)
  assert.equal(execution.stdout.trim(), versions[0], '带空格路径的入口可在新终端调用')
  await call(false)
  const started = await fetch(`${origin}/api/start`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ version: versions[1], profile: 'web' }), signal: AbortSignal.timeout(10000),
  })
  assert.equal(started.status, 200, await started.text())
  await call(true)
  const liveShim = await readFile(join(binDir, 'dsh.cmd'), 'utf8')
  assert.ok(liveShim.includes(join(dataDir, 'versions', versions[1])), '开启时优先跟随正在运行的实例')
  registryWritable = false
  assert.equal((await call(false)).systemPathResult.ok, false, '注册表写入失败返回明确结果')
  assert.equal(userPath, `C:\\existing-tools;${binDir}`, '失败不破坏原 PATH')
})

// macOS/Linux 只提供手动指引，保存与重启都不能改写用户的 shell 配置。
test('macOS/Linux PATH API：重复开关、持久化与进程重启，shell 文件不变', { skip: process.platform === 'win32', timeout: 20000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-path-api-'))
  const app = isolateUserHome(root)
  await mkdir(app, { recursive: true })
  const settingsFile = join(app, 'settings.json')
  await writeFile(settingsFile, JSON.stringify({ dataDir: join(root, 'data'), dshHome: join(root, '.dsh'), systemPath: false, seedMarket: false }))
  const names = ['.zshrc', '.zprofile', '.zshenv', '.bashrc', '.bash_profile', '.profile']
  for (const name of names) await writeFile(join(root, name), `# untouched ${name}\n`)
  let child
  async function stop() {
    if (!child || child.exitCode !== null) return
    const ended = once(child, 'exit')
    child.kill('SIGTERM')
    const force = setTimeout(() => child.kill('SIGKILL'), 2000)
    await ended
    clearTimeout(force)
  }
  t.after(async () => { await stop(); await rm(root, { recursive: true, force: true }) })
  const port = await new Promise((resolve, reject) => {
    const probe = createServer().on('error', reject).listen(0, '127.0.0.1', () => {
      const p = probe.address().port
      probe.close(() => resolve(p))
    })
  })
  async function start() {
    const script = `import {startServer,stopAll} from ${JSON.stringify(new URL('../src/server.js', import.meta.url).href)}; process.on('SIGTERM',()=>stopAll().finally(()=>process.exit(0))); console.log('READY '+await startServer());`
    child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, HOME: root, APPDATA: root, DSH_VERSIONS_DATA: join(root, 'data'), DSH_HOME: join(root, '.dsh'), PORT: String(port), PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', errors = ''
    child.stderr.on('data', (b) => { errors += b })
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`启动超时：${errors}`)), 4000)
      child.on('error', (e) => { clearTimeout(timer); reject(e) })
      child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`启动退出 ${code}: ${errors}`)) })
      child.stdout.on('data', (b) => {
        output += b
        const match = output.match(/READY (http:\/\/127\.0\.0\.1:\d+)/)
        if (match) { clearTimeout(timer); resolve(match[1]) }
      })
    })
  }
  let origin = await start()
  async function call(enabled) {
    const res = await fetch(`${origin}/api/settings`, enabled === undefined ? { signal: AbortSignal.timeout(3000) } : { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ systemPath: enabled }), signal: AbortSignal.timeout(3000) })
    const data = await res.json()
    assert.equal(res.status, 200, JSON.stringify(data))
    assert.equal(data.systemPathMode, 'manual')
    return data
  }
  assert.equal((await call()).systemPath, false)
  for (const enabled of [true, true, false, false, true]) {
    const data = await call(enabled)
    assert.equal(data.systemPath, enabled)
    assert.equal(data.systemPathResult.ok, false, '设置保存不等于已改 PATH')
    assert.match(data.systemPathResult.message, enabled ? /手动添加/ : /移除添加/)
    if (!enabled) assert.doesNotMatch(data.systemPathResult.message, /export PATH=/)
    assert.equal(JSON.parse(await readFile(settingsFile, 'utf8')).systemPath, enabled)
  }
  await stop()
  origin = await start()
  assert.equal((await call()).systemPath, true, '新的 Node 进程从磁盘读回开启状态')
  await call(false)
  await stop()
  origin = await start()
  assert.equal((await call()).systemPath, false, '关闭也能跨进程保留')
  for (const name of names) assert.equal(await readFile(join(root, name), 'utf8'), `# untouched ${name}\n`)
  const log = await readFile(join(app, 'manager.log'), 'utf8')
  assert.match(log, /系统 PATH 未改：如曾手动添加/)
})
