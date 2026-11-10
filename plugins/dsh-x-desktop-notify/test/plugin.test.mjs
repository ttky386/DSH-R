import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

/** 极简 cordis 上下文：只实现本插件用到的 on / get / provide / logger。 */
function fakeContext(services = {}) {
  const handlers = new Map()
  const provided = new Map()
  return {
    handlers,
    provided,
    on(type, handler) {
      if (!handlers.has(type)) handlers.set(type, [])
      handlers.get(type).push(handler)
      return () => {}
    },
    get(name) {
      return services[name] ?? provided.get(name)
    },
    provide(name, value) {
      provided.set(name, value)
      return () => {}
    },
    logger: { warn() {} },
  }
}

function emit(ctx, type, ...args) {
  for (const handler of ctx.handlers.get(type) ?? []) handler(...args)
}

/** 装上桌面环境变量和 fetch 桩；测试结束还原。 */
function withDesktop(t, { enable = true } = {}) {
  const before = {
    url: process.env.DSH_X_MANAGER_URL,
    desktop: process.env.DSH_X_DESKTOP,
    fetch: globalThis.fetch,
  }
  process.env.DSH_X_MANAGER_URL = 'http://127.0.0.1:3780'
  if (enable) process.env.DSH_X_DESKTOP = '1'
  else delete process.env.DSH_X_DESKTOP
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    return new Response(JSON.stringify({ ok: true, shown: true }), { status: 200 })
  }
  t.after(() => {
    for (const [key, value] of [['DSH_X_MANAGER_URL', before.url], ['DSH_X_DESKTOP', before.desktop]]) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    globalThis.fetch = before.fetch
  })
  return calls
}

const session = (overrides = {}) => ({ id: 's1', header: {}, ...overrides })

/** 人类直接输入的一条 user/message（source.kind 是区分注入内容的关键）。 */
const humanMessage = (text) => ({
  role: 'user',
  source: { kind: 'user' },
  content: [{ type: 'text', text }],
})

test('一轮完成：发一条原生通知，正文是用户那句话', (t) => {
  const calls = withDesktop(t)
  const ctx = fakeContext({
    webServer: { getOrigin: () => 'http://127.0.0.1:3799' },
    sessionTitle: { get: () => ({ title: '重构登录页' }) },
  })
  apply(ctx, {})
  emit(ctx, 'session/event', session(), { type: 'turn/start', time: 1_000, data: {} })
  emit(ctx, 'session/event', session(), { type: 'user/message', time: 1_100, data: humanMessage('把登录按钮改成蓝色') })
  emit(ctx, 'session/event', session(), { type: 'turn/end', time: 46_000, data: { reason: { kind: 'completed' } } })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'http://127.0.0.1:3780/api/desktop/notify')
  assert.deepEqual(calls[0].body, {
    title: '任务已完成',
    body: '任务：把登录按钮改成蓝色',
    url: 'http://127.0.0.1:3799',
  })
})

test('user/message：合成的注入上下文不进通知，只认人类输入', (t) => {
  const calls = withDesktop(t)
  const ctx = fakeContext()
  apply(ctx, {})
  emit(ctx, 'session/event', session(), { type: 'turn/start', time: 0, data: {} })
  emit(ctx, 'session/event', session(), {
    type: 'user/message',
    time: 10,
    data: { role: 'user', source: { kind: 'model' }, content: [{ type: 'text', text: 'AGENTS.md 已更新' }] },
  })
  emit(ctx, 'session/event', session(), { type: 'turn/end', time: 1_000, data: { reason: { kind: 'completed' } } })
  assert.equal(calls[0].body.body, '会话 · 1s')
})

test('user/message：同一轮只认第一句人话', (t) => {
  const calls = withDesktop(t)
  const ctx = fakeContext()
  apply(ctx, {})
  emit(ctx, 'session/event', session(), { type: 'turn/start', time: 0, data: {} })
  emit(ctx, 'session/event', session(), { type: 'user/message', time: 10, data: humanMessage('第一句') })
  emit(ctx, 'session/event', session(), { type: 'user/message', time: 20, data: humanMessage('第二句') })
  emit(ctx, 'session/event', session(), { type: 'turn/end', time: 1_000, data: { reason: { kind: 'completed' } } })
  assert.equal(calls[0].body.body, '任务：第一句')
})

test('用户中止的轮次默认不发；打开 notifyOnAborted 才发', (t) => {
  const calls = withDesktop(t)
  const ctx = fakeContext()
  apply(ctx, {})
  emit(ctx, 'session/event', session(), { type: 'turn/start', time: 0, data: {} })
  emit(ctx, 'session/event', session(), { type: 'turn/end', time: 1_000, data: { reason: { kind: 'aborted' } } })
  assert.equal(calls.length, 0)

  const ctx2 = fakeContext()
  apply(ctx2, { notifyOnAborted: true })
  emit(ctx2, 'session/event', session(), { type: 'turn/start', time: 0, data: {} })
  emit(ctx2, 'session/event', session(), { type: 'turn/end', time: 1_000, data: { reason: { kind: 'aborted' } } })
  assert.equal(calls.length, 1)
})

test('子代理的轮次默认不发；includeSubagents 打开才发', (t) => {
  const calls = withDesktop(t)
  const ctx = fakeContext()
  apply(ctx, {})
  const child = session({ id: 's2', header: { origin: 'subagent', delegationDepth: 1 } })
  emit(ctx, 'session/event', child, { type: 'turn/start', time: 0, data: {} })
  emit(ctx, 'session/event', child, { type: 'turn/end', time: 500, data: { reason: { kind: 'completed' } } })
  assert.equal(calls.length, 0)

  const ctx2 = fakeContext()
  apply(ctx2, { includeSubagents: true })
  emit(ctx2, 'session/event', child, { type: 'turn/start', time: 0, data: {} })
  emit(ctx2, 'session/event', child, { type: 'turn/end', time: 500, data: { reason: { kind: 'completed' } } })
  assert.equal(calls.length, 1)
})

test('等审批：提醒一条，正文带任务原文，并原样把裁决交给 next()', (t) => {
  const calls = withDesktop(t)
  const ctx = fakeContext({ sessionTitle: { get: () => ({ title: '部署脚本' }) } })
  apply(ctx, {})
  emit(ctx, 'session/event', session(), { type: 'turn/start', time: 0, data: {} })
  emit(ctx, 'session/event', session(), { type: 'user/message', time: 10, data: humanMessage('把构建产物发布到 CDN') })
  let nextCalled = 0
  const outcome = 'allow-once'
  const returned = ctx.handlers.get('approval/request')[0](
    { agent: { session: session() }, toolName: 'bash', reason: '会执行 rm -rf build' },
    () => { nextCalled += 1; return Promise.resolve(outcome) },
  )
  assert.ok(returned instanceof Promise)
  return returned.then((value) => {
    assert.equal(value, outcome)
    assert.equal(nextCalled, 1)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].body.title, '等你确认')
    assert.equal(calls[0].body.body, '任务：把构建产物发布到 CDN\nbash 需要你确认：会执行 rm -rf build')
  })
})

test('不在 DSH-X 里：一条请求都不发，dshDesktop 服务是禁用的', (t) => {
  const calls = withDesktop(t, { enable: false })
  const ctx = fakeContext()
  apply(ctx, {})
  emit(ctx, 'session/event', session(), { type: 'turn/start', time: 0, data: {} })
  emit(ctx, 'session/event', session(), { type: 'turn/end', time: 5_000, data: { reason: { kind: 'completed' } } })
  assert.equal(calls.length, 0)
  assert.equal(ctx.provided.get('dshDesktop').enabled, false)
})

test('onTurnEnd=false 关掉自动提醒，服务仍然在', (t) => {
  const calls = withDesktop(t)
  const ctx = fakeContext()
  apply(ctx, { onTurnEnd: false })
  emit(ctx, 'session/event', session(), { type: 'turn/start', time: 0, data: {} })
  emit(ctx, 'session/event', session(), { type: 'turn/end', time: 5_000, data: { reason: { kind: 'completed' } } })
  assert.equal(calls.length, 0)
  assert.equal(ctx.provided.get('dshDesktop').enabled, true)
})

test('没有 turn/start 记录时，正文不带时长', (t) => {
  const calls = withDesktop(t)
  const ctx = fakeContext()
  apply(ctx, {})
  emit(ctx, 'session/event', session(), { type: 'turn/end', time: 5_000, data: { reason: { kind: 'completed' } } })
  assert.equal(calls[0].body.body, '会话')
})

test('会话销毁后清掉轮次起点，下一次结束不带时长', (t) => {
  const calls = withDesktop(t)
  const ctx = fakeContext()
  apply(ctx, {})
  emit(ctx, 'session/event', session(), { type: 'turn/start', time: 0, data: {} })
  emit(ctx, 'session/disposed', session())
  emit(ctx, 'session/event', session(), { type: 'turn/end', time: 5_000, data: { reason: { kind: 'completed' } } })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].body.body, '会话')
})
