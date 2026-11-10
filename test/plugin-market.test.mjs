import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { isolateUserHome } from './isolated-home.mjs'
import { pluginMarketDefaultsPatch, load } from '../src/compat/plugin-market.mjs'

const root = mkdtempSync(join(tmpdir(), 'dsh-plugin-market-'))
const app = isolateUserHome(root)
const { DEFAULTS, safePluginMarketSources, loadSettings, loadSettingsSync, saveSettings } = await import('../src/settings.js')
test.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))

test('默认使用 Awesome DSH Plugin，旧预装开关不迁移；源校验、去重和持久化', async () => {
  assert.deepEqual(DEFAULTS.pluginMarketSources, ['https://awesome-dsh-plugin.com/index.json'])
  assert.deepEqual((await loadSettings()).pluginMarketSources, DEFAULTS.pluginMarketSources)
  mkdirSync(app, { recursive: true })
  writeFileSync(join(app, 'settings.json'), JSON.stringify({ seedMarket: true }))
  assert.deepEqual((await loadSettings()).pluginMarketSources, DEFAULTS.pluginMarketSources)
  assert.equal((await loadSettings()).seedMarket, undefined)
  for (const value of [null, '', ['file:///tmp/market.json'], ['https://user:pass@example.com/'], ['https://example.com/#'], ['relative'], [123]]) {
    assert.throws(() => safePluginMarketSources(value), /插件源/)
  }
  const urls = ['https://example.com/index.json', 'http://localhost:8765/index.json']
  assert.deepEqual(safePluginMarketSources([` ${urls[0]} `, ...urls]), urls)
  await saveSettings({ pluginMarketSources: urls, seedMarket: true })
  assert.deepEqual(loadSettingsSync().pluginMarketSources, urls)
  assert.equal(JSON.parse(readFileSync(join(app, 'settings.json'))).seedMarket, undefined)
  await assert.rejects(saveSettings({ pluginMarketSources: ['javascript:alert(1)'] }), /插件源/)
  assert.deepEqual((await loadSettings()).pluginMarketSources, urls)
  await saveSettings({ pluginMarketSources: [] })
  assert.deepEqual((await loadSettings()).pluginMarketSources, [])
  assert.deepEqual(loadSettingsSync().pluginMarketSources, [], '主动清空后不能重新加回默认源')
})

test('钩子仅修改目标模块的缺省值，源码变化或未配置时原样跳过', () => {
  const anchor = String.raw`indexes: z.array(z.string().pattern(/^https?:\/\/\S+$/u)).default([]).volatile()`
  const urls = ['https://example.com/index.json?literal=$&']
  const patched = pluginMarketDefaultsPatch(anchor, JSON.stringify(urls))
  assert.ok(patched.includes(`.default(${JSON.stringify(urls)})`), 'URL 中的 $& 不作替换指令处理')
  for (const value of [undefined, '[]', '{}', 'invalid']) assert.equal(pluginMarketDefaultsPatch(anchor, value), null)
  assert.equal(pluginMarketDefaultsPatch('indexes: newSchema()', JSON.stringify(urls)), null)
  const original = { format: 'module', source: anchor }
  assert.equal(load('file:///other/index.js', {}, () => original), original)
})

test('真实官方市场 schema：缺省、已有源和主动清空相互独立', (t) => {
  // 本地有官方运行时才补做真实 schema 验证；CI 的离线用例不依赖下载 dsh。
  const runtime = new URL('../data/versions/0.2.1-rc.2/node_modules/@deepseek-ai/dsh-plugin-market/lib/index.js', import.meta.url)
  if (!existsSync(runtime)) return t.skip('未安装官方 rc.2 运行时')
  const urls = DEFAULTS.pluginMarketSources
  const script = `
    import assert from 'node:assert/strict'
    import Market from ${JSON.stringify(runtime.href)}
    assert.deepEqual(Market.Config({}).indexes.get(), ${JSON.stringify(urls)})
    assert.deepEqual(Market.Config({ indexes: [] }).indexes.get(), [])
    assert.deepEqual(Market.Config({ indexes: ['https://custom.example/index.json'] }).indexes.get(), ['https://custom.example/index.json'])
  `
  const child = spawnSync(process.execPath, ['--import', new URL('../src/compat/register.mjs', import.meta.url).href, '--input-type=module', '-e', script], {
    env: { ...process.env, DSH_X_PLUGIN_MARKET_SOURCES: JSON.stringify(urls) }, encoding: 'utf8', timeout: 15000,
  })
  assert.equal(child.status, 0, child.stderr)
})

test('管理页保存默认源只改设置，启动不再安装或重新启用 dshmarket', async (t) => {
  const data = join(root, 'data'), home = join(root, 'home'), profile = join(home, 'profiles', 'web')
  const binary = join(data, 'versions', '9.9.9', 'node_modules', '@deepseek-ai', 'dsh', 'lib')
  mkdirSync(binary, { recursive: true })
  mkdirSync(profile, { recursive: true })
  const manifest = JSON.stringify({ dependencies: { dshmarket: '1.0.0' }, dsh: { profile: { bundles: [] } } })
  writeFileSync(join(profile, 'package.json'), manifest)
  writeFileSync(join(profile, 'cordis.patch.yml'), '[]\n')
  writeFileSync(join(data, 'config.json'), JSON.stringify({ versions: ['9.9.9'] }))
  const envFile = join(root, 'child-env.json')
  writeFileSync(join(binary, 'bin.js'), `
    import { createServer } from 'node:http'
    import { writeFileSync } from 'node:fs'
    // 桌面增强（dsh-x-*）由启动器在启动前自动补装，属于预期行为；别的一律不许装。
    if (process.argv.includes('plugin')) {
      if (!process.argv.join(' ').includes('dsh-x-')) { console.error('不应自动安装插件'); process.exit(1) }
      process.exit(0)
    }
    writeFileSync(${JSON.stringify(envFile)}, JSON.stringify(process.env.DSH_X_PLUGIN_MARKET_SOURCES))
    const server = createServer((req, res) => res.end('<html>ok</html>'))
    server.listen(0, '127.0.0.1', () => console.log('dsh web: http://127.0.0.1:' + server.address().port + '/?token=test'))
  `)
  writeFileSync(join(app, 'settings.json'), JSON.stringify({ dataDir: data, dshHome: home, seedMarket: true, proxyMode: 'off' }))
  const probe = createServer()
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  process.env.PORT = String(probe.address().port)
  await new Promise(resolve => probe.close(resolve))
  const server = await import('../src/server.js')
  const origin = await server.startServer()
  t.after(() => server.stopAll())
  const post = async (path, body) => {
    const response = await fetch(origin + path, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() }
  }
  assert.deepEqual((await (await fetch(origin + '/api/settings')).json()).pluginMarketSources, DEFAULTS.pluginMarketSources)
  const urls = DEFAULTS.pluginMarketSources
  const saved = await post('/api/settings', { pluginMarketSources: urls })
  assert.equal(saved.status, 200, JSON.stringify(saved.body))
  assert.deepEqual(saved.body.pluginMarketSources, urls)
  assert.equal(existsSync(envFile), false, '保存设置不启动 dsh 或插件安装')
  const invalid = await post('/api/settings', { pluginMarketSources: ['ftp://example.com/index.json'] })
  assert.equal(invalid.status, 500)
  assert.deepEqual((await loadSettings()).pluginMarketSources, urls)
  const started = await post('/api/start', { version: '9.9.9', profile: 'web' })
  assert.equal(started.status, 200, JSON.stringify(started.body))
  assert.equal(JSON.parse(readFileSync(envFile, 'utf8')), JSON.stringify(urls))
  // 启动不再自动安装任何插件（桌面增强改成设置里手动一键装）：profile 必须原样不动。
  assert.equal(readFileSync(join(profile, 'package.json'), 'utf8'), manifest, '保留旧市场及其禁用状态')
  assert.equal(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8'), '[]\n')
  assert.doesNotMatch(await (await fetch(origin + '/api/logs/export')).text(), /不应自动安装插件|预装.*失败/)
  await server.stopAll()
})
