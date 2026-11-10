import test from 'node:test'
import assert from 'node:assert/strict'
import { managerOrigin, desktopAvailable, createDesktopClient } from '../lib/desktop.js'

test('管理页地址：只留 origin，坏地址当没有', () => {
  assert.equal(managerOrigin({ DSH_X_MANAGER_URL: 'http://127.0.0.1:3780' }), 'http://127.0.0.1:3780')
  assert.equal(managerOrigin({ DSH_X_MANAGER_URL: ' http://127.0.0.1:3780/?a=1 ' }), 'http://127.0.0.1:3780')
  assert.equal(managerOrigin({ DSH_X_MANAGER_URL: 'https://127.0.0.1:3780/' }), 'https://127.0.0.1:3780')
  assert.equal(managerOrigin({ DSH_X_MANAGER_URL: 'file:///tmp/x' }), '')
  assert.equal(managerOrigin({ DSH_X_MANAGER_URL: 'not a url' }), '')
  assert.equal(managerOrigin({}), '')
})

test('可用性：DSH_X_DESKTOP=1 和地址缺一不可', () => {
  assert.equal(desktopAvailable({ DSH_X_DESKTOP: '1', DSH_X_MANAGER_URL: 'http://127.0.0.1:3780' }), true)
  assert.equal(desktopAvailable({ DSH_X_MANAGER_URL: 'http://127.0.0.1:3780' }), false)
  assert.equal(desktopAvailable({ DSH_X_DESKTOP: '1' }), false)
  assert.equal(desktopAvailable({ DSH_X_DESKTOP: 'true', DSH_X_MANAGER_URL: 'http://127.0.0.1:3780' }), false)
})

test('没有桌面能力：不发请求，返回 no-desktop', async () => {
  let calls = 0
  const client = createDesktopClient({
    env: {},
    fetch: async () => { calls += 1; return new Response('{}') },
  })
  assert.equal(client.enabled, false)
  assert.deepEqual(await client.notify({ title: 'x' }), { ok: false, shown: false, reason: 'no-desktop' })
  assert.equal(calls, 0)
})

test('notify 打到 /api/desktop/notify，JSON 正文原样带过去', async () => {
  const calls = []
  const client = createDesktopClient({
    env: { DSH_X_DESKTOP: '1', DSH_X_MANAGER_URL: 'http://127.0.0.1:3780' },
    fetch: async (url, init) => {
      calls.push({ url, method: init.method, body: init.body })
      return new Response(JSON.stringify({ ok: true, shown: true }), { status: 200 })
    },
  })
  assert.equal(client.enabled, true)
  assert.deepEqual(await client.notify({ title: '完成', body: '会话' }), { ok: true, shown: true })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'http://127.0.0.1:3780/api/desktop/notify')
  assert.equal(calls[0].method, 'POST')
  assert.deepEqual(JSON.parse(calls[0].body), { title: '完成', body: '会话' })
})

test('外壳没有 host.desktop：503 原样带回 available=false', async () => {
  const client = createDesktopClient({
    env: { DSH_X_DESKTOP: '1', DSH_X_MANAGER_URL: 'http://127.0.0.1:3780' },
    fetch: async () => new Response(JSON.stringify({ available: false, error: '没有桌面能力' }), { status: 503 }),
  })
  const result = await client.notify({ title: 'x' })
  assert.equal(result.ok, false)
  assert.equal(result.status, 503)
  assert.equal(result.available, false)
})

test('调不通：返回 unreachable，不抛异常', async () => {
  const client = createDesktopClient({
    env: { DSH_X_DESKTOP: '1', DSH_X_MANAGER_URL: 'http://127.0.0.1:3780' },
    fetch: async () => { throw new TypeError('fetch failed') },
  })
  const result = await client.notify({ title: 'x' })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'unreachable')
  assert.match(result.error, /fetch failed/)
})

test('其余动作的正文形状', async () => {
  const bodies = []
  const client = createDesktopClient({
    env: { DSH_X_DESKTOP: '1', DSH_X_MANAGER_URL: 'http://127.0.0.1:3780' },
    fetch: async (url, init) => {
      bodies.push({ url, body: JSON.parse(init.body) })
      return new Response('{"ok":true}', { status: 200 })
    },
  })
  await client.open('https://example.com')
  await client.reveal('C:\\tmp\\a.zip')
  await client.clipboard('hello')
  await client.dialog({ kind: 'open' })
  assert.deepEqual(bodies.map((item) => item.url), [
    'http://127.0.0.1:3780/api/desktop/open',
    'http://127.0.0.1:3780/api/desktop/reveal',
    'http://127.0.0.1:3780/api/desktop/clipboard',
    'http://127.0.0.1:3780/api/desktop/dialog',
  ])
  assert.deepEqual(bodies.map((item) => item.body), [
    { url: 'https://example.com' },
    { path: 'C:\\tmp\\a.zip' },
    { text: 'hello' },
    { kind: 'open' },
  ])
})

test('info：GET /api/desktop，没有桌面能力时不发请求', async () => {
  let requested = ''
  const client = createDesktopClient({
    env: { DSH_X_DESKTOP: '1', DSH_X_MANAGER_URL: 'http://127.0.0.1:3780' },
    fetch: async (url) => {
      requested = url
      return new Response(JSON.stringify({ available: true, capabilities: ['notify'] }), { status: 200 })
    },
  })
  assert.deepEqual(await client.info(), { available: true, capabilities: ['notify'] })
  assert.equal(requested, 'http://127.0.0.1:3780/api/desktop')
  const off = createDesktopClient({ env: {}, fetch: async () => { throw new Error('不该调') } })
  assert.deepEqual(await off.info(), { available: false, reason: 'no-desktop' })
})
