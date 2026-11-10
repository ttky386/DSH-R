import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { setImmediate } from 'node:timers/promises'

const html = readFileSync(new URL('../src/public/index.html', import.meta.url), 'utf8')
const start = html.indexOf('    async function executeRepair(')
const end = html.indexOf('    function verificationText(', start)

function fixture(approved = true, kind = 'disable-optional') {
  let resolvePost
  let rejectPost
  const pending = new Promise((resolve, reject) => {
    resolvePost = resolve
    rejectPost = reject
  })
  const button = { textContent: '禁用这些插件', disabled: false }
  const other = { textContent: '其他操作', disabled: false }
  const blocked = { textContent: '不可自动修复', disabled: true }
  const context = {
    repairPlanView: { busy: false, sequence: 1 },
    repairPresentation: () => ({ title: 'test', recommendation: 'test', rollback: 'test' }),
    appConfirm: async () => approved,
    t: text => text,
    noticeEl: {},
    noticeTextEl: { textContent: '' },
    noticeCardsEl: { querySelectorAll: () => [button, other, blocked] },
    calls: 0,
    records: [],
    post() {
      context.calls += 1
      return pending
    },
    showRepairHistory(records) {
      context.records.push(...records)
    },
    appendCurrentDiagnosisButton(parent, target) {
      context.refreshTarget = target
    },
  }
  vm.runInNewContext(html.slice(start, end) + '\nthis.execute = executeRepair', context)
  const preview = { id: 'preview', target: { version: '1', profile: 'test', home: '/isolated' } }
  const action = { id: 'action', kind, component: 'test' }
  return { context, button, other, blocked, resolvePost, rejectPost, run: () => context.execute(preview, action, 1, button) }
}

test('confirmed disable immediately shows progress and blocks duplicate actions while request is pending', async () => {
  const item = fixture()
  const running = item.run()
  assert.equal(item.button.textContent, '禁用这些插件')
  assert.equal(item.button.disabled, false)
  assert.equal(item.context.calls, 0)
  await setImmediate()
  assert.equal(item.context.calls, 1)
  assert.equal(item.button.textContent, '正在禁用并复验…')
  assert.equal(item.button.disabled, true)
  assert.equal(item.other.disabled, true)
  assert.equal(item.blocked.disabled, true)
  await item.run()
  assert.equal(item.context.calls, 1)
  const record = { status: 'applied' }
  item.resolvePost(record)
  await running
  assert.equal(item.context.records[0], record)
  assert.equal(item.context.repairPlanView.busy, false)
})

test('cancellation leaves buttons untouched and sends no request', async () => {
  const item = fixture(false)
  await item.run()
  assert.equal(item.context.calls, 0)
  assert.equal(item.button.textContent, '禁用这些插件')
  assert.equal(item.button.disabled, false)
  assert.equal(item.other.disabled, false)
})

test('failed request preserves existing error feedback without a stale progress label', async () => {
  const item = fixture()
  const running = item.run()
  await setImmediate()
  assert.equal(item.context.calls, 1)
  assert.equal(item.button.textContent, '正在禁用并复验…')
  item.rejectPost(new Error('current request failed'))
  await running
  assert.match(item.context.noticeTextEl.textContent, /^current request failed/)
  assert.match(item.context.noticeTextEl.textContent, /不能据此认定未发生修改/)
  assert.equal(item.button.textContent, '禁用这些插件')
  assert.equal(item.button.disabled, true)
  assert.equal(item.context.records.length, 0)
  assert.equal(item.context.refreshTarget.home, '/isolated')
})

test('package operation uses neutral progress wording', async () => {
  const item = fixture(true, 'package')
  const running = item.run()
  await setImmediate()
  assert.equal(item.button.textContent, '正在处理并复验…')
  item.resolvePost({})
  await running
})
