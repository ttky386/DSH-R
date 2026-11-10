import assert from 'node:assert/strict'
import { isolateUserHome } from './isolated-home.mjs'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

test('插件体检报告：能读、没记录时 missing、非法参数回 400', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-plugin-profile-'))
  const app = isolateUserHome(root)
  const data = join(root, 'data')
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  mkdirSync(app, { recursive: true })
  process.env.PORT = String(port)
  process.env.DSH_VERSIONS_DATA = data
  process.env.DSH_AGENTS_HOME = join(root, 'agents')
  const server = await import('../src/server.js')
  const base = await server.startServer()
  t.after(async () => {
    await server.stopAll()
    try { rmSync(root, { recursive: true, force: true }) } catch { /* 留给系统临时目录清理 */ }
  })

  // 报告由 perf/plugin-profile.mjs 在正常启动时写入，接口只负责读。
  const dir = join(app, 'plugin-profile')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '0.1.7@web.json'), JSON.stringify({
    version: '0.1.7',
    profile: 'web',
    at: Date.now(),
    windowMs: 4321,
    cpuMs: 4000,
    allocMB: 12.5,
    packages: [{ name: 'demo-plugin', cpuMs: 120, allocKB: 2048, plugin: true }],
    native: [{ name: 'readFileUtf8', cpuMs: 300 }],
    entries: [],
  }))

  const found = await (await fetch(`${base}/api/plugin-profile?version=0.1.7&profile=web`)).json()
  assert.equal(found.version, '0.1.7')
  assert.equal(found.profile, 'web')
  assert.equal(found.packages[0].name, 'demo-plugin')
  assert.equal(found.missing, undefined)

  const missing = await (await fetch(`${base}/api/plugin-profile?version=0.1.8&profile=web`)).json()
  assert.equal(missing.missing, true)
  assert.deepEqual(missing.packages, [])

  // 版本号会拼进文件名，非法字符必须挡在接口上，不能进目录。
  const bad = await fetch(`${base}/api/plugin-profile?version=${encodeURIComponent('../evil')}&profile=web`)
  assert.equal(bad.status, 400)
})
