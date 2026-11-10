/**
 * 插件桌面 API 的外壳侧策略（shell/desktop.mjs）：通知开关 / 声音 / 节流、点击目标、
 * Electron 对话框选项。真正的 Notification / dialog 调用在 main.mjs（需要 Electron），
 * 这里只盯纯函数那半。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { NOTIFY_GAP_MS, clickTarget, dialogOptions, notificationDecision, notifyThrottled } from '../shell/desktop.mjs'

const read = (path) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8')

test('插件通知：声音关掉静音，插件只能关小不能打开；任务通知开关不再管插件', () => {
  assert.deepEqual(
    notificationDecision({}, { taskNotifications: false, notificationSound: true }),
    { enabled: true, silent: false, reason: '' },
    '任务通知开关只管外壳自己的实例提醒，不拦插件通知',
  )
  assert.deepEqual(
    notificationDecision({}, { taskNotifications: true, notificationSound: false }),
    { enabled: true, silent: true, reason: '' },
    '用户关掉提示音时通知照发，只是静音',
  )
  assert.deepEqual(
    notificationDecision({ silent: true }, { taskNotifications: true, notificationSound: true }),
    { enabled: true, silent: true, reason: '' },
    '插件可以把自己的通知关小声',
  )
  assert.deepEqual(
    notificationDecision({ silent: false }, { taskNotifications: true, notificationSound: false }),
    { enabled: true, silent: true, reason: '' },
    '插件不能打开用户关掉的提示音',
  )
  assert.deepEqual(
    notificationDecision({}, { taskNotifications: true, notificationSound: true }),
    { enabled: true, silent: false, reason: '' },
  )
})

test('通知点击地址只认 http(s)，其余退回管理页', () => {
  assert.equal(clickTarget('http://127.0.0.1:9716/?token=x'), 'http://127.0.0.1:9716/?token=x')
  assert.equal(clickTarget('https://example.com/a'), 'https://example.com/a')
  assert.equal(clickTarget('file:///C:/Windows/System32/calc.exe'), '')
  assert.equal(clickTarget('javascript:alert(1)'), '')
  assert.equal(clickTarget(''), '')
  assert.equal(clickTarget(null), '')
})

test('插件通知节流：间隔内丢掉，间隔外放行', () => {
  assert.equal(notifyThrottled(0, 1000), false, '第一条通知永远放行')
  assert.equal(notifyThrottled(1000, 1100), true)
  assert.equal(notifyThrottled(1000, 1000 + NOTIFY_GAP_MS - 1), true)
  assert.equal(notifyThrottled(1000, 1000 + NOTIFY_GAP_MS), false)
})

test('对话框选项：三种 kind 映射到 Electron，脏属性被丢掉', () => {
  const open = dialogOptions({ kind: 'open', options: { title: '选文件', properties: ['openFile', 'evil'], filters: [] } })
  assert.deepEqual(open, { title: '选文件', properties: ['openFile'] }, '空 filters 不往 Electron 传')
  const unknownProperty = dialogOptions({ kind: 'open', options: { properties: ['showHiddenFiles'] } })
  assert.deepEqual(unknownProperty.properties, ['showHiddenFiles'], '白名单里的属性照传')

  const save = dialogOptions({ kind: 'save', options: { title: '', defaultPath: 'a.zip', filters: [{ name: 'ZIP', extensions: ['zip'] }] } })
  assert.deepEqual(save, { defaultPath: 'a.zip', filters: [{ name: 'ZIP', extensions: ['zip'] }] })

  const message = dialogOptions({ kind: 'message', options: { type: 'question', message: '现在同步吗？', detail: '', buttons: ['同步', '取消'], defaultId: 0, cancelId: 1 } })
  assert.deepEqual(message, { type: 'question', message: '现在同步吗？', buttons: ['同步', '取消'], defaultId: 0, cancelId: 1 })
  const noButtons = dialogOptions({ kind: 'message', options: { message: '好' } })
  assert.deepEqual(noButtons, { type: 'info', message: '好' }, '没有按钮时不带 buttons / defaultId / cancelId')

  assert.equal(dialogOptions({ kind: 'nope', options: {} }), null)
  assert.equal(dialogOptions({ kind: 'open' }), null)
})

test('桌面模块不跨层依赖：核心不 import Electron / 外壳，外壳不 import 核心', () => {
  const core = read('src/desktop.js').replace(/\/\*[\s\S]*?\*\//g, '')
  assert.doesNotMatch(core, /from 'electron'/, '核心模块不能依赖 Electron')
  assert.doesNotMatch(core, /from '\.\.\//, '核心不能反向 import 外壳')
  const shell = read('shell/desktop.mjs').replace(/\/\*[\s\S]*?\*\//g, '')
  assert.doesNotMatch(shell, /from '\.\.\//, '外壳不能 import 核心模块（拆包后目录里没有）')
})
