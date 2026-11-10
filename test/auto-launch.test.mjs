import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { isolateUserHome } from './isolated-home.mjs'

test('自动启动不阻塞管理页，遵守逐项勾选、版本与目录，单项失败不挡其他项', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-auto-launch-'))
  const app = isolateUserHome(root), data = join(root, 'data'), home = join(root, 'home'), other = join(root, 'other')
  for (const path of [app, home, other]) mkdirSync(path, { recursive: true })
  const preset = (id, name, version, dshHome, autoLaunch = true) => ({ id: id.repeat(16), name, version, dshHome, profile: 'web', port: 0, autoLaunch })
  const entries = [
    preset('a', '固定旧版本', '9.9.8', home), preset('b', '另一个目录', 'auto', other),
    preset('c', '缺少内核', '9.9.7', home), preset('d', '手动启动', '9.9.9', home, false),
  ]
  const settings = join(app, 'settings.json')
  writeFileSync(settings, JSON.stringify({ dataDir: data, dshHome: home, seedMarket: false, proxyMode: 'off', launchPresets: entries }))
  for (const version of ['9.9.8', '9.9.9']) {
    const binary = join(data, 'versions', version, 'node_modules', '@deepseek-ai', 'dsh', 'lib')
    mkdirSync(binary, { recursive: true })
    writeFileSync(join(binary, 'bin.js'), `
import { createServer } from 'node:http'
import { appendFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
appendFileSync(join(process.env.DSH_HOME, 'spawned'), '${version}\\n')
while (!existsSync(join(process.env.DSH_HOME, 'release'))) await new Promise(resolve => setTimeout(resolve, 10))
const server = createServer((req, res) => res.end(process.env.DSH_HOME))
const at = process.argv.indexOf('--port')
server.listen(Number(process.argv[at + 1]), '127.0.0.1', () => console.log('dsh web: http://127.0.0.1:' + server.address().port + '/?token=auto'))
`)
  }
  const probe = createServer()
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  process.env.PORT = String(probe.address().port)
  await new Promise(resolve => probe.close(resolve))
  const { startServer, stopAll } = await import('../src/server.js')
  const { safeLaunchPresets } = await import('../src/settings.js')
  t.after(async () => {
    await stopAll()
    // taskkill 是异步子进程；同步重试会挡住它的回调，得让出事件循环等 cwd 释放。
    for (let attempt = 0; attempt < 20; attempt++) {
      try { rmSync(root, { recursive: true, force: true }); return }
      catch (error) {
        if (attempt === 19) throw error
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
  })
  const origin = await startServer()
  const state = async () => (await fetch(origin + '/api/state')).json()
  const waitFor = async (predicate) => {
    const deadline = Date.now() + 10000
    while (!await predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
    assert.ok(await predicate(), '等待自动启动状态超时')
  }
  await waitFor(() => existsSync(join(home, 'spawned')) && existsSync(join(other, 'spawned')))
  const pending = await state()
  assert.equal(pending.instances.length, 2, '未勾选项和缺失版本不能拉起其他版本代替')
  assert.ok(pending.instances.every(item => item.status === 'starting'), '内核还在等待，管理页已经可用')
  assert.equal(readFileSync(join(home, 'spawned'), 'utf8'), '9.9.8\n', '固定版本不能变成最高版本')
  assert.equal(readFileSync(join(other, 'spawned'), 'utf8'), '9.9.9\n', 'auto 使用已装最高版本')
  const duplicate = fetch(origin + '/api/start', { method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-launch-id': entries[0].id }, body: JSON.stringify({ version: '9.9.8', profile: 'web' }) })
  for (const dir of [home, other]) writeFileSync(join(dir, 'release'), '')
  assert.equal((await duplicate).status, 200)
  await waitFor(async () => (await state()).instances.every(item => item.status === 'running'))
  assert.equal(readFileSync(join(home, 'spawned'), 'utf8'), '9.9.8\n', '手动再点不会重复 spawn')
  const snapshot = await state()
  for (const item of snapshot.instances) assert.equal(await (await fetch(item.url)).text(), item.home)
  assert.match(await (await fetch(origin + '/api/logs/export')).text(), /自动启动「缺少内核」已跳过/)

  const saved = await fetch(origin + '/api/launch-presets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...entries[0], autoLaunch: false }) })
  assert.equal(saved.status, 200)
  const stored = JSON.parse(readFileSync(settings, 'utf8')).launchPresets
  assert.equal(stored.find(item => item.id === entries[0].id).autoLaunch, undefined, '取消勾选落盘')
  assert.equal(stored.find(item => item.id === entries[1].id).autoLaunch, true, '启动历史写入保留其他项勾选')
  assert.equal(safeLaunchPresets().some(item => item.autoLaunch), false, '旧设置不自动启用')
  assert.equal(safeLaunchPresets([{ ...entries[0], autoLaunch: 'false' }]).at(-1).autoLaunch, undefined)

  await stopAll()
  for (const dir of [home, other]) rmSync(join(dir, 'spawned'))
  await startServer()
  await stopAll()
  // 取消发生在设置写队列/端口探测期间时，也不能在退出后另起子进程。
  await new Promise(resolve => setTimeout(resolve, 500))
  assert.equal(existsSync(join(other, 'spawned')), false)
})
