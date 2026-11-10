import test from 'node:test'
import assert from 'node:assert/strict'
import { approvalNotice, formatDuration, turnNotice } from '../lib/notify.js'

test('时长：秒 / 分 / 小时', () => {
  assert.equal(formatDuration(0), '0s')
  assert.equal(formatDuration(42_000), '42s')
  assert.equal(formatDuration(134_000), '2m 14s')
  assert.equal(formatDuration(120_000), '2m')
  assert.equal(formatDuration(3_780_000), '1h 3m')
  assert.equal(formatDuration(Number.NaN), '')
  assert.equal(formatDuration(-1), '')
})

test('turn/end：正文是用户那句话，标题是「任务已完成」', () => {
  const payload = turnNotice({
    reason: { kind: 'completed' },
    task: '打开浏览器登录b站',
    sessionTitle: '重构登录页',
    startedAt: 1_000,
    endedAt: 46_000,
    origin: 'http://127.0.0.1:3799/?token=x',
  })
  assert.deepEqual(payload, {
    title: '任务已完成',
    body: '任务：打开浏览器登录b站',
    url: 'http://127.0.0.1:3799',
  })
})

test('turn/end：拿不到任务原文时退回会话标题 + 时长', () => {
  const payload = turnNotice({
    reason: { kind: 'completed' },
    sessionTitle: '重构登录页',
    startedAt: 1_000,
    endedAt: 46_000,
    origin: 'http://127.0.0.1:3799/?token=x',
  })
  assert.deepEqual(payload, {
    title: '任务已完成',
    body: '重构登录页 · 45s',
    url: 'http://127.0.0.1:3799',
  })
})

test('turn/end：任务原文压成一行并截断', () => {
  const payload = turnNotice({ reason: { kind: 'completed' }, task: `第一行\n\n第二行\t${'长'.repeat(200)}` })
  assert.ok(payload.body.startsWith('任务：第一行 第二行 '))
  assert.ok(!payload.body.includes('\n'))
  assert.ok(payload.body.length <= '任务：'.length + 120)
})

test('turn/end：error 带错误信息，标题是「任务失败」', () => {
  const payload = turnNotice({
    reason: { kind: 'error', error: { message: 'provider 401' } },
    task: '跑测试',
    sessionTitle: '跑测试',
    startedAt: 0,
    endedAt: 3_000,
  })
  assert.equal(payload.title, '任务失败')
  assert.equal(payload.body, '任务：跑测试\n错误：provider 401')
  assert.equal(payload.url, undefined)
})

test('turn/end：max-tokens / blocked 也提醒', () => {
  assert.equal(turnNotice({ reason: { kind: 'max-tokens' } }).title, '达到输出上限')
  assert.equal(turnNotice({ reason: { kind: 'blocked' } }).title, '任务已阻断')
})

test('turn/end：aborted 默认不提醒，打开开关才提醒', () => {
  assert.equal(turnNotice({ reason: { kind: 'aborted' }, notifyOnAborted: false }), null)
  assert.equal(turnNotice({ reason: { kind: 'aborted' } }), null)
  assert.equal(turnNotice({ reason: { kind: 'aborted' }, notifyOnAborted: true }).title, '任务已停止')
})

test('turn/end：interrupted / forked / 未知原因不提醒', () => {
  assert.equal(turnNotice({ reason: { kind: 'interrupted' } }), null)
  assert.equal(turnNotice({ reason: { kind: 'forked' } }), null)
  assert.equal(turnNotice({ reason: { kind: 'whatever' } }), null)
  assert.equal(turnNotice({}), null)
})

test('turn/end：没有标题时正文是「会话」，非 http 地址丢掉', () => {
  const payload = turnNotice({ reason: { kind: 'completed' }, origin: 'file:///tmp/x' })
  assert.equal(payload.body, '会话')
  assert.equal(payload.url, undefined)
})

test('审批：第一行任务原文，第二行工具、原因', () => {
  const payload = approvalNotice({
    task: '把构建产物发布到 CDN',
    sessionTitle: '部署脚本',
    toolName: 'bash',
    reason: '会执行 rm -rf build',
    origin: 'http://127.0.0.1:3799',
  })
  assert.equal(payload.title, '等你确认')
  assert.equal(payload.body, '任务：把构建产物发布到 CDN\nbash 需要你确认：会执行 rm -rf build')
  assert.equal(payload.url, 'http://127.0.0.1:3799')
})

test('审批：没有任务原文时用会话标题，没有工具名和原因也能成句', () => {
  assert.equal(
    approvalNotice({ sessionTitle: '部署脚本', toolName: 'bash', reason: '会执行 rm -rf build' }).body,
    '部署脚本\nbash 需要你确认：会执行 rm -rf build',
  )
  assert.equal(approvalNotice({}).body, '会话\n有一个操作需要你确认')
})
