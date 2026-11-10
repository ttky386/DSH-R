/**
 * 插件桌面 API（/api/desktop/*）：能力清单、请求清洗、外壳转发和降级行为。
 *
 * 用假的外壳（setHost({ desktop })）跑：真正弹通知 / 对话框需要 Electron，测不了；
 * 这里盯的是核心这一侧——什么请求能过、转发给外壳的形状、没有外壳时怎么答。
 */
import assert from 'node:assert/strict'
import { isolateUserHome } from './isolated-home.mjs'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const read = (path) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8')

test('插件桌面 API：能力清单、请求校验与外壳转发', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-api-'))
  const app = isolateUserHome(root)
  const home = join(root, 'home')
  const data = join(root, 'data')
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  mkdirSync(app, { recursive: true })
  const profile = join(home, 'profiles', 'web')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ private: true, dsh: { profile: { bundles: [] } } }))
  writeFileSync(join(app, 'settings.json'), JSON.stringify({ dataDir: data, dshHome: home, profile: 'web', seedMarket: false }))
  process.env.APPDATA = root
  process.env.PORT = String(port)
  process.env.DSH_VERSIONS_DATA = data
  process.env.DSH_AGENTS_HOME = join(root, 'agents')
  const server = await import('../src/server.js')
  const base = await server.startServer()
  t.after(async () => {
    await server.stopAll()
    try { rmSync(root, { recursive: true, force: true }) } catch { /* 留给系统临时目录清理 */ }
  })

  async function call(path, body) {
    const res = await fetch(base + path, body === undefined ? undefined : {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: res.status, ...(await res.json()) }
  }

  await t.test('没接外壳时：清单说不可用，动作返回 503（浏览器模式 / 旧外壳）', async () => {
    const info = await call('/api/desktop')
    assert.equal(info.status, 200)
    assert.equal(info.api, 1)
    assert.equal(info.available, false)
    assert.deepEqual(info.capabilities, [], '没有 Electron 外壳就没有任何桌面能力')
    const denied = await call('/api/desktop/notify', { title: 'x' })
    assert.equal(denied.status, 503)
    assert.equal(denied.available, false)
    const env = server.dshEnv('0.1.7')
    assert.equal(env.DSH_X_MANAGER_URL, base, '管理器地址每次启动可能变，环境变量给实际地址')
    assert.equal('DSH_X_DESKTOP' in env, false, '没有外壳能力时不宣告 DSH_X_DESKTOP')
  })

  const calls = []
  let notifyResult = { shown: true }
  const desktop = {
    info: () => ({ theme: 'dark', versions: { shell: '9.9.9', electron: '44.7.0' } }),
    notify: (request) => { calls.push(['notify', request]); return notifyResult },
    open: (request) => { calls.push(['open', request]) },
    reveal: (request) => { calls.push(['reveal', request]) },
    clipboard: (request) => { calls.push(['clipboard', request]) },
    dialog: (request) => {
      calls.push(['dialog', request])
      return request.kind === 'message' ? { response: 1 } : { canceled: false, paths: [join(root, 'picked.zip')] }
    },
  }
  server.setHost({ desktop })

  await t.test('接上外壳后：清单带能力、主题与两层版本，插件环境宣告可用', async () => {
    const info = await call('/api/desktop')
    assert.equal(info.available, true)
    assert.deepEqual(info.capabilities, ['notify', 'open', 'reveal', 'clipboard', 'dialog'])
    assert.equal(info.theme, 'dark')
    assert.equal(info.versions.shell, '9.9.9')
    assert.equal(info.versions.electron, '44.7.0')
    assert.equal(info.versions.core, JSON.parse(read('package.json')).version)
    assert.deepEqual(info.notifications, { enabled: true, sound: true })
    const env = server.dshEnv('0.1.7')
    assert.equal(env.DSH_X_DESKTOP, '1')
  })

  await t.test('通知：清洗文本、透传静音与点击地址，插件失败原因原样带回', async () => {
    const sent = await call('/api/desktop/notify', {
      title: '  同步完成  ',
      body: '3 个会话\n已上传',
      silent: true,
      url: 'http://127.0.0.1:9716/#/panel',
    })
    assert.equal(sent.status, 200)
    assert.equal(sent.shown, true)
    assert.deepEqual(calls.at(-1), ['notify', {
      action: 'notify',
      title: '同步完成',
      body: '3 个会话\n已上传',
      silent: true,
      url: 'http://127.0.0.1:9716/#/panel',
    }])

    const long = await call('/api/desktop/notify', { title: 'x'.repeat(200) })
    assert.equal(long.status, 200)
    assert.equal(calls.at(-1)[1].title.length, 120, '标题按上限截断')
    assert.equal(calls.at(-1)[1].url, '', '没给地址就没有点击目标')

    assert.equal((await call('/api/desktop/notify', {})).status, 400, '空通知要拒绝')
    assert.equal((await call('/api/desktop/notify', { title: 'x', url: 'file:///etc/passwd' })).status, 400, '点击地址只认 http(s)')

    notifyResult = { shown: false, reason: 'disabled' }
    const disabled = await call('/api/desktop/notify', { body: '内容' })
    assert.equal(disabled.status, 200)
    assert.equal(disabled.shown, false)
    assert.equal(disabled.reason, 'disabled', '用户关掉通知时插件要能区分，不是报错')
    notifyResult = { shown: true }
  })

  await t.test('打开链接：只收 http(s)，本机 / 外部由外壳再分派', async () => {
    await call('/api/desktop/open', { url: 'https://example.com/a?b=1' })
    assert.deepEqual(calls.at(-1), ['open', { action: 'open', url: 'https://example.com/a?b=1' }])
    assert.equal((await call('/api/desktop/open', { url: 'javascript:alert(1)' })).status, 400)
    assert.equal((await call('/api/desktop/open', { url: '' })).status, 400)
  })

  await t.test('在文件中显示：绝对路径 + 真实存在，缺一个都拒绝', async () => {
    const file = join(root, 'backup.zip')
    writeFileSync(file, 'x')
    await call('/api/desktop/reveal', { path: file })
    assert.deepEqual(calls.at(-1), ['reveal', { action: 'reveal', path: file }])
    assert.equal((await call('/api/desktop/reveal', { path: join(root, 'missing.zip') })).status, 400, '不存在的路径不能拿去开文件管理器')
    assert.equal((await call('/api/desktop/reveal', { path: 'relative.zip' })).status, 400, '只收绝对路径')
  })

  await t.test('剪贴板：只写文本，超长拒绝', async () => {
    await call('/api/desktop/clipboard', { text: 'hello' })
    assert.deepEqual(calls.at(-1), ['clipboard', { action: 'clipboard', text: 'hello' }])
    assert.equal((await call('/api/desktop/clipboard', { text: 42 })).status, 400)
    assert.equal((await call('/api/desktop/clipboard', { text: 'x'.repeat(100_001) })).status, 400)
  })

  await t.test('对话框：open / save / message 三种形状，越界参数有兜底', async () => {
    await call('/api/desktop/dialog', {
      kind: 'open',
      title: '选文件',
      multiple: true,
      filters: [{ name: 'ZIP', extensions: ['.zip', 'bad ext'] }],
    })
    const open = calls.at(-1)[1]
    assert.equal(open.kind, 'open')
    assert.deepEqual(open.options.properties, ['openFile', 'multiSelections'])
    assert.deepEqual(open.options.filters, [{ name: 'ZIP', extensions: ['zip'] }], '扩展名去点、非法项丢掉')

    await call('/api/desktop/dialog', { kind: 'save', defaultPath: 'backup.zip' })
    assert.equal(calls.at(-1)[1].kind, 'save')
    assert.equal(calls.at(-1)[1].options.defaultPath, 'backup.zip')

    const message = await call('/api/desktop/dialog', {
      kind: 'message',
      message: '现在同步吗？',
      buttons: ['同步', '取消'],
      defaultId: 0,
      cancelId: 9,
    })
    assert.equal(message.response, 1)
    const request = calls.at(-1)[1]
    assert.equal(request.options.type, 'info', '没给 type 时按信息框')
    assert.equal(request.options.cancelId, 1, '越界的 cancelId 回落到最后一个按钮')

    assert.equal((await call('/api/desktop/dialog', { kind: 'nope' })).status, 400)
    assert.equal((await call('/api/desktop/dialog', { kind: 'message' })).status, 400, '消息框必须有 message')
  })

  await t.test('路由边界：未知动作 404、方法不对 405、跨站来源 403', async () => {
    assert.equal((await call('/api/desktop/nope', {})).status, 404)
    const get = await fetch(`${base}/api/desktop/notify`)
    assert.equal(get.status, 405)
    const post = await fetch(`${base}/api/desktop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(post.status, 405)
    const cross = await fetch(`${base}/api/desktop/notify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ title: 'x' }),
    })
    assert.equal(cross.status, 403, '改状态的请求只认本机来源')
  })

  await t.test('打包清单带上核心新模块', () => {
    assert.match(read('scripts/pack-common.mjs'), /'desktop\.js',/, 'APP_FILES 要带 desktop.js，否则安装包里的核心起不来')
  })
})
