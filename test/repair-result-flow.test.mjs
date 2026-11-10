import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const html = readFileSync(new URL('../src/public/index.html', import.meta.url), 'utf8')

function element(tag) {
  return {
    tag,
    children: [],
    style: {},
    textContent: '',
    disabled: false,
    open: false,
    append(...children) {
      this.children.push(...children)
    },
    replaceChildren(...children) {
      this.children = children
    },
    scrollIntoView() {
      this.scrolled = true
    },
    focus() {
      this.focused = true
    },
  }
}

function descendants(node) {
  return [node, ...(node.children || []).flatMap(descendants)]
}

function fixture() {
  const cards = element('cards')
  const context = {
    state: {},
    document: { createElement: element },
    t: value => value,
    repairPlanView: { sequence: 1, busy: false },
    noticeEl: { classList: { add() {
    } } },
    noticeTextEl: { textContent: '' },
    noticeDiagnosisEl: {}, noticeOutputTitleEl: {},
    noticeCardsEl: cards,
    notify() {
      cards.replaceChildren()
    },
    cardLine(parent, label, value) {
      if (value !== null && value !== undefined && value !== '') {
        parent.append({ tag: 'line', label, textContent: String(value) })
      }
    },
    evidenceDetails(parent, label, value) {
      parent.append({ tag: 'details', label, value, open: false })
    },
    executeRepair() {
    },
  }
  const start = html.indexOf('    function repairCard(')
  const end = html.indexOf('    async function showRepairCards', start)
  vm.runInNewContext(html.slice(start, end), context)
  const historyStart = html.indexOf('    function verificationText(')
  const historyEnd = html.indexOf('    /** 启动这条线', historyStart)
  vm.runInNewContext(html.slice(historyStart, historyEnd), context)
  return { context, cards }
}

test('result names the action and separates restored startup from remaining optional problems', () => {
  const { context, cards } = fixture()
  context.showRepairHistory([{
    id: 'record',
    action: { kind: 'uninstall-introducer', component: 'credentials', owner: { name: 'example-owner', version: '1.0.0' } },
    target: {}, status: 'applied', verificationStatus: 'complete',
    recorded: { changes: [
      { operation: 'package_inventory_changed', before: { name: 'old-package' }, after: { present: false } },
      { operation: 'installation_manifest_changed', path: '/profile/package.json' },
      { operation: 'resolved_package', after: { version: '2.0.0' } },
    ] },
    outcome: { status: 'partial', ready: true, alive: true, remaining: { failed: 1, rejected: 0, required: 0, waiting: 1, skipped: 0 }, remainingItems: { failed: ['telemetry-example'], waiting: ['waiting-example'] } },
  }])
  const nodes = descendants(cards)
  assert.ok(nodes.some(node => node.tag === 'h3' && node.textContent.includes('example-owner')))
  assert.ok(nodes.some(node => node.label === '启动结果' && node.textContent.includes('已恢复启动')))
  assert.ok(nodes.some(node => node.label === '剩余项目' && node.textContent.includes('telemetry-example') && node.textContent.includes('waiting-example')))
  assert.ok(nodes.some(node => node.label === '实际改动汇总' && /包移除 1/.test(node.textContent) && /清单或配置变更 1/.test(node.textContent) && /解析变更 1/.test(node.textContent)))
})

test('result exposes non-plugin startup error even when every plugin counter is zero', () => {
  const { context, cards } = fixture()
  context.showRepairHistory([{
    action: { kind: 'uninstall-introducer', owner: { name: 'example-owner' } }, target: {}, status: 'applied',
    recorded: { changes: [] }, verificationStatus: 'complete',
    outcome: { status: 'unresolved', ready: false, alive: false, message: 'EADDRINUSE: isolated test port', remaining: { failed: 0, rejected: 0, required: 0, waiting: 0, skipped: 0 } },
  }])
  const nodes = descendants(cards)
  assert.ok(nodes.some(node => node.label === '启动结果' && node.textContent.includes('未恢复启动')))
  assert.ok(nodes.some(node => node.label === '启动错误' && node.textContent.includes('EADDRINUSE')))
})

test('execute failure displays its persisted record instead of leaving the stale preview', async () => {
  const { context } = fixture()
  const record = { id: 'preview', action: { id: 'action' }, status: 'applied_verification_failed', verificationStatus: 'failed' }
  const button = { textContent: '卸载依赖引入者' }
  context.noticeCardsEl.querySelectorAll = () => [button]
  context.appConfirm = async () => true
  context.post = async () => {
    throw Object.assign(new Error('verify failed'), { repairRecord: record })
  }
  let displayed
  context.showRepairHistory = records => {
    displayed = records
  }
  const start = html.indexOf('    async function executeRepair(')
  const end = html.indexOf('    function verificationText(', start)
  vm.runInNewContext(html.slice(start, end), context)
  await context.executeRepair({ id: 'preview', target: {} }, { id: 'action', kind: 'uninstall-introducer' }, 1, button)
  assert.equal(displayed?.[0], record)
})

test('shared owner is linked once and blocked actions retain their actual names', () => {
  const { context } = fixture()
  const problem = { observations: [], confirmations: [] }
  const source = { id: 'remove-owner', kind: 'uninstall-introducer', component: 'credentials', owner: { name: 'example-owner', version: '1' }, affectedComponents: ['credentials', 'sessions'], problem }
  const blocked = { id: 'update-sessions', kind: 'package', component: 'sessions', disabledReason: 'source unknown', problem }
  const other = { id: 'update-other', kind: 'package', component: 'unrelated', disabledReason: 'source unknown', problem }
  const result = context.renderRepairActionGroups({ actions: [source, blocked, other] }, 1)
  const sessionNodes = descendants(result[1])
  const link = sessionNodes.find(node => node.tag === 'button' && node.textContent.includes('查看统一卸载方案'))
  assert.ok(link)
  assert.match(link.textContent, /可执行，需确认/)
  link.onclick()
  assert.equal(result[0].scrolled, true)
  assert.ok(sessionNodes.some(node => node.tag === 'button' && node.textContent.includes('更新旧插件') && node.disabled))
  assert.ok(!descendants(result[2]).some(node => node.textContent?.includes('查看统一卸载方案')))
  const paired = context.renderRepairActionGroups({ actions: [source, { ...blocked, component: 'credentials' }] }, 1)
  const nodes = descendants(paired[0])
  assert.ok(nodes.some(node => node.label === '处理方式' && node.textContent.includes('本卡可直接执行 1')))
  assert.ok(sessionNodes.some(node => node.label === '处理方式' && node.textContent.includes('本卡可直接执行 0')))
  assert.ok(!nodes.some(node => node.textContent?.includes('二选一')))
})

test('verification records names from observed report rather than inventing labels', () => {
  const source = readFileSync(new URL('../src/repair-actions.js', import.meta.url), 'utf8')
  const start = source.indexOf('export function verificationSummary(')
  const end = source.indexOf('/** 预览、执行', start)
  const context = {}
  vm.runInNewContext(source.slice(start, end).replace('export function', 'function'), context)
  const result = context.verificationSummary(true, true, { failed: [{ id: 'failed-a' }], rejected: [{ package: 'pkg-b' }], blockingChains: [{ id: 'required-c', service: 'svc-c' }], waiting: [{ id: 'waiting-d' }], skipped: { entries: [{ id: 'skip-e' }] }, truncated: false })
  assert.equal(result.remainingItems.failed[0], 'failed-a')
  assert.equal(result.remainingItems.waiting[0], 'waiting-d')
  assert.equal(result.remainingItems.required[0], 'required-c → svc-c')
})

test('repair error response includes only matching persisted operation record', async () => {
  const source = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8')
  const start = source.indexOf("  if (req.method === 'POST' && ['/api/diagnosis/repair/preview'")
  const end = source.indexOf("  if (req.method === 'POST' && ['/api/diagnosis/plan'", start)
  const id = 'a'.repeat(32)
  for (const matches of [true, false]) {
    const record = { id, action: { id: matches ? 'requested-action' : 'different-action' }, status: 'applied_verification_failed' }
    let response
    await vm.runInNewContext('(async () => {' + source.slice(start, end) + '})()', {
      req: { method: 'POST' }, url: { pathname: '/api/diagnosis/repair/execute' }, body: { id, actionId: 'requested-action' }, res: {},
      diagnosticRepairs: {
        execute: async () => {
          throw Object.assign(new Error('verify failed'), { repairRecord: record })
        },
        readRecord: () => record,
      },
      emitState: async () => {
      }, publicFailure: value => value, recordedChanges: () => ({ changes: [] }),
      send(responseObject, status, data) {
        response = { status, data }
      },
    })
    assert.equal(response.status, 409)
    assert.equal(Boolean(response.data.repairRecord), matches)
  }
})

test('rejected duplicate execute and rollback preconditions do not return old successful records', async () => {
  const source = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8')
  const start = source.indexOf("  if (req.method === 'POST' && ['/api/diagnosis/repair/preview'")
  const end = source.indexOf("  if (req.method === 'POST' && ['/api/diagnosis/plan'", start)
  const id = 'b'.repeat(32)
  const oldRecord = { id, action: { id: 'requested-action' }, outcome: { status: 'resolved', ready: true, alive: true } }
  for (const route of ['execute', 'rollback']) {
    let response
    let historyReads = 0
    const reject = async () => {
      throw new Error('operation rejected before mutation')
    }
    await vm.runInNewContext('(async () => {' + source.slice(start, end) + '})()', {
      req: { method: 'POST' }, url: { pathname: '/api/diagnosis/repair/' + route }, body: { id, actionId: 'requested-action' }, res: {},
      diagnosticRepairs: { execute: reject, rollback: reject, readRecord() {
        historyReads += 1
        return oldRecord
      } },
      emitState: async () => {
      }, publicFailure: value => value, recordedChanges: () => ({ changes: [] }),
      send(responseObject, status, data) {
        response = { status, data }
      },
    })
    assert.equal(response.status, 409)
    assert.equal(response.data.repairRecord, undefined)
    assert.equal(historyReads, 0)
  }
})

test('ordinary waiting is collapsed after actions while confirmed required blocking stays visible', async () => {
  const { context, cards } = fixture()
  const preview = {
    target: { home: '/isolated', profile: 'desktop', version: '1' },
    actions: [{ id: 'action', component: 'fault-plugin', kind: 'disable-optional', disabledReason: 'required dependency' }],
    runtimeState: {
      phase: 'initializing', requiredInactive: ['initializing-only'],
      requiredDependencyChains: [{ edges: [{ from: 'required', service: 'needed', to: 'fault-plugin' }] }],
    },
    blockingChains: [{ id: 'unproved-waiter', service: 'unknown-service' }],
    waiting: [{ id: 'unproved-waiter', missing: ['unknown-service'] }],
    waitingServices: [{ service: 'unknown-service', consumers: [{ id: 'ordinary-waiter', required: false }] }],
  }
  context.post = async () => preview
  context.noticeDetailEl = { textContent: 'original log' }
  const start = html.indexOf('    async function showRepairCards(')
  const end = html.indexOf('    async function executeRepair(', start)
  vm.runInNewContext(html.slice(start, end), context)
  await context.showRepairCards({ binding: {}, diagnosis: {} })
  const actionIndex = cards.children.findIndex(card => descendants(card).some(node => node.tag === 'h3' && node.textContent === 'fault-plugin'))
  const waitingIndex = cards.children.findIndex(card => card.tag === 'details' && descendants(card).some(node => node.textContent?.includes('ordinary-waiter')))
  assert.ok(actionIndex >= 0 && waitingIndex > actionIndex)
  assert.equal(cards.children[waitingIndex].open, false)
  assert.ok(cards.children.some(card => card.tag === 'section' && descendants(card).some(node => node.textContent === '已确认必需服务依赖阻塞')))
})

test('refreshing a running warning preserves its running status and does not reuse the preview', async () => {
  const { context } = fixture()
  const target = { home: '/isolated', profile: 'desktop', version: '1' }
  const warning = { message: 'optional plugin failed', binding: { attemptId: 'new-attempt' } }
  context.getJson = async () => ({ instances: [{ ...target, diagnosticWarning: warning }] })
  let shown
  context.showFailure = (failure, running) => {
    shown = { failure, running }
  }
  const parent = element('container')
  context.appendCurrentDiagnosisButton(parent, target)
  await parent.children[0].onclick()
  assert.equal(shown.failure, warning)
  assert.equal(shown.running, true)
})
