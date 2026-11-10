/**
 * 停实例：必须确认进程真的没了，才允许交还控制权。
 *
 * 这条钉的是 issue #57（插件市场里重启后连不上、node.exe 脱离启动器、随后插件文件被占用）
 * 背后那几处「杀完就当死了」的写法：
 *
 * 1. 等 'close' 而不是 'exit'：'close' 要等 stdout/stderr 两条**管道**关闭，而 dsh 拉起的
 *    插件、subprocess 之类的孙进程会继承它们。孙进程脱离父进程后 taskkill /T 按树收不到，
 *    管道就一直开着——可 dsh 自己早就没了。等 'close' 的 stop 会白等 5 秒，然后删掉跟踪记录
 *    往下走，重启时旧进程可能还占着 profile 和端口。
 * 2. killTree 是 fire-and-forget：taskkill 失败没人知道，进程活着一律当死了。
 * 3. taskkill 拉不起来时（PATH 被改、精简系统）：spawn 的 'error' 没人接，管理服务自己会
 *    被未捕获错误打死。
 *
 * 用假 dsh 跑：真的监听端口、打印就绪行、把自己的 PID 写下来，再按需造一个「握着管道却不在
 * 进程树里」的孙进程。进程是真是假、怎么死的，全是真的。
 */
import assert from 'node:assert/strict'
import { isolateUserHome } from './isolated-home.mjs'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const FAKE_DSH = `import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const version = process.env.DSH_VERSION || 'unknown'
const pidDir = process.env.DSH_TEST_PID_DIR
if (pidDir) {
  mkdirSync(pidDir, { recursive: true })
  writeFileSync(join(pidDir, version + '.pid'), String(process.pid))
}
// 孙进程：helper 继承我们的 stdout/stderr（也就是启动器那边的管道），再让 helper 起一个
// sleeper（同样继承这对管道）后立刻退出。于是 sleeper 的父进程没了，taskkill /T 按树
// 收不到它，可管道写端还攥在它手里。
const orphanFile = process.env.DSH_TEST_PIPE_ORPHAN
if (orphanFile) {
  const helper = \`
const { spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true })
child.unref()
writeFileSync(process.env.DSH_TEST_PIPE_ORPHAN, String(child.pid))
\`
  spawn(process.execPath, ['-e', helper], { stdio: ['ignore', 'inherit', 'inherit'] })
}
const srv = createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.end('<!doctype html><html><body>fake dsh</body></html>')
})
const portAt = process.argv.indexOf('--port')
srv.listen(portAt >= 0 ? Number(process.argv[portAt + 1]) : 0, '127.0.0.1', () => {
  console.log('dsh web: http://127.0.0.1:' + srv.address().port + '/?token=fake')
})
`

const PLAIN = '0.2.0'
const PIPE = '0.2.1'
const NO_TASKKILL = '0.2.2'

/** 挑一个当前没人用的端口给管理器。 */
function freePort() {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

/** 进程还活着吗（process.kill 的 0 号信号在 Windows 上也是查存在）。 */
function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code !== 'ESRCH'
  }
}

/** 等进程彻底消失：exit 事件到句柄释放有一小段，别让断言跑在它前面。 */
async function waitGone(pid, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  while (alive(pid)) {
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return true
}

async function waitFile(file, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`等不到 ${file}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return readFileSync(file, 'utf8').trim()
}

const appDir = mkdtempSync(join(tmpdir(), 'dsh-reap-'))
const APP = isolateUserHome(appDir)
const DATA = join(appDir, 'data')
const HOME = join(appDir, 'home')
const PID_DIR = join(appDir, 'pids')
process.env.APPDATA = appDir
process.env.PORT = String(await freePort())
// 假 dsh 继承进程环境（dshEnv 以 process.env 打底），用它把自己的 PID 报出来
process.env.DSH_TEST_PID_DIR = PID_DIR
mkdirSync(APP, { recursive: true })
mkdirSync(HOME, { recursive: true })
for (const version of [PLAIN, PIPE, NO_TASKKILL]) {
  const lib = join(DATA, 'versions', version, 'node_modules', '@deepseek-ai', 'dsh', 'lib')
  mkdirSync(lib, { recursive: true })
  writeFileSync(join(lib, 'bin.js'), FAKE_DSH, 'utf8')
}
writeFileSync(join(APP, 'settings.json'), JSON.stringify({
  dataDir: DATA,
  dshHome: HOME,
  profile: 'web',
  seedMarket: false,
}), 'utf8')

const { startServer, stopAll } = await import('../src/server.js')
const base = await startServer()

async function api(path, body, launchId = '') {
  const response = await fetch(`${base}${path}`, body === undefined
    ? { headers: launchId ? { 'x-dsh-launch-id': launchId } : {} }
    : { method: 'POST', headers: { 'content-type': 'application/json', ...(launchId ? { 'x-dsh-launch-id': launchId } : {}) }, body: JSON.stringify(body) })
  const data = await response.json()
  if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`)
  return data
}

const state = () => api('/api/state')
const fakePid = async (version) => Number(await waitFile(join(PID_DIR, `${version}.pid`)))
const stopped = async (version, profile = 'web') => api('/api/stop', { version, profile })

const orphans = new Set()
async function killOrphan(pid) {
  try { process.kill(pid) } catch { /* 早没了 */ }
  await waitGone(pid, 3000)
  orphans.delete(pid)
}

test.after(async () => {
  await stopAll()
  for (const pid of [...orphans]) await killOrphan(pid)
  for (let i = 0; i < 10; i += 1) {
    try {
      rmSync(appDir, { recursive: true, force: true })
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
})

test('停止后实例和进程都真的没了', async () => {
  const started = await api('/api/start', { version: PLAIN })
  assert.ok(started.url)
  const pid = await fakePid(PLAIN)
  assert.ok(alive(pid), '假 dsh 该在跑')

  await stopped(PLAIN)
  assert.equal((await state()).instances.length, 0, '跟踪表里不该再有它')
  assert.ok(await waitGone(pid), '进程也必须真的退出')
})

test('孙进程握着 stdout 管道时，停止照样很快返回', async () => {
  // 这条就是旧实现的死穴：等 'close' 会等到 5 秒上限，然后删记录走人。
  const orphanFile = join(appDir, 'orphan.pid')
  rmSync(orphanFile, { force: true })
  process.env.DSH_TEST_PIPE_ORPHAN = orphanFile
  try {
    await api('/api/start', { version: PIPE })
    const pid = await fakePid(PIPE)
    const orphan = Number(await waitFile(orphanFile))
    orphans.add(orphan)
    assert.ok(alive(orphan), '握着管道的孙进程该活着')

    const began = Date.now()
    await stopped(PIPE)
    const spent = Date.now() - began
    assert.ok(spent < 2500, `停止该等进程退出（'exit'），不是等管道关闭（'close'）；实际 ${spent}ms`)
    assert.equal((await state()).instances.length, 0, '跟踪表里不该再有它')
    assert.ok(await waitGone(pid), 'dsh 进程必须真的退出')
  } finally {
    delete process.env.DSH_TEST_PIPE_ORPHAN
    for (const pid of [...orphans]) await killOrphan(pid)
  }
})

test('taskkill 拉不起来时，用 Node 自己的 kill 兜底', async () => {
  // 旧代码的 spawn('taskkill') 没挂 'error'：这里会把管理服务打死；就算没打死，也是静默留个孤儿。
  await api('/api/start', { version: NO_TASKKILL })
  const pid = await fakePid(NO_TASKKILL)
  const path = process.env.PATH
  let error = ''
  try {
    process.env.PATH = ''
    await stopped(NO_TASKKILL)
  } catch (caught) {
    error = caught.message
  } finally {
    process.env.PATH = path
  }
  assert.equal(error, '', `停止不该失败：${error}`)
  assert.equal((await state()).instances.length, 0, '跟踪表里不该再有它')
  assert.ok(await waitGone(pid), '兜底也必须把进程真的杀掉')
})

test('停下没在跑的组合不算错', async () => {
  const result = await stopped(PLAIN)
  assert.deepEqual(result, { ok: true })
})

test('stopAll 之后没有活着的实例进程', async () => {
  await api('/api/start', { version: PLAIN })
  await api('/api/start', { version: PIPE })
  const pids = [await fakePid(PLAIN), await fakePid(PIPE)]
  assert.ok(pids.every(alive), '两个都该在跑')

  await stopAll()
  for (const pid of pids) assert.ok(await waitGone(pid), '退出前必须把子进程收掉，不能留孤儿')
})
