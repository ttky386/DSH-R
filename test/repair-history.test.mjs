import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

test('verification precedes collapsed changes and every recorded change remains available', () => {
  const html = readFileSync(new URL('../src/public/index.html', import.meta.url), 'utf8')
  const start = html.indexOf('    function verificationText(')
  const end = html.indexOf('    /** 启动这条线', start)
  function element(tag) {
    return {
      tag,
      open: false,
      children: [],
      append(child) {
        this.children.push(child)
      },
    }
  }
  const cards = element('cards')
  const context = {
    state: {},
    notify() {
    },
    t: value => value,
    repairPlanView: {},
    noticeEl: { classList: { add() {
    } } },
    noticeCardsEl: cards,
    repairPresentation: () => ({ title: 'uninstall', rollback: 'no automatic rollback' }),
    repairCard: () => element('card'),
    cardLine(parent, label, value) {
      parent.append({ label, value })
    },
    evidenceDetails(parent, label, value) {
      parent.append({ label, value })
    },
    recordedChangeText: change => change.path,
    verificationText: () => 'verification completed with remaining issues',
    document: { createElement: element },
  }
  vm.runInNewContext(html.slice(start, end), context)
  const changes = Array.from({ length: 66 }, (_, index) => ({ path: `package-${index}` }))
  context.showRepairHistory([{ action: { kind: 'uninstall-introducer' }, target: {}, status: 'applied', recorded: { changes }, outcome: { status: 'partial' } }])
  const card = cards.children[0]
  const verificationIndex = card.children.findIndex(child => child.tag === 'section')
  const changesIndex = card.children.findIndex(child => child.tag === 'details')
  assert.ok(verificationIndex >= 0 && changesIndex > verificationIndex)
  const details = card.children[changesIndex]
  assert.equal(details.open, false)
  assert.equal(details.children.filter(child => child.label === '已记录修改').length, changes.length)
  assert.equal(details.children.filter(child => child.label === '修改前后与位置').length, changes.length)
  assert.equal(card.children.some(child => child.tag === 'button'), false)
  assert.equal(card.children.find(child => child.label === '卸载结果').value, '官方卸载命令完成')
  for (const status of ['prepared', 'uninstalling', 'interrupted', 'uninstall_failed']) {
    cards.children = []
    context.showRepairHistory([{ action: { kind: 'uninstall-introducer' }, target: {}, status, recorded: { changes: [] } }])
    const pendingCard = cards.children[0]
    assert.equal(pendingCard.children.find(child => child.label === '卸载结果').value, '尚未确认官方卸载命令完成')
  }
  for (const failedUninstall of [true, false]) {
    cards.children = []
    context.showRepairHistory([{
      action: { kind: 'uninstall-introducer' }, target: {}, recorded: { changes: [] },
      status: failedUninstall ? 'uninstall_failed' : 'applied_verification_failed',
      error: failedUninstall ? 'ERR_PNPM_EXAMPLE affected-package' : undefined,
      verificationStatus: 'failed', verificationError: 'fresh verification failed', outcome: null,
    }])
    const result = cards.children[0]
    assert.equal(result.children.find(child => child.label === '卸载结果').value,
      failedUninstall ? 'ERR_PNPM_EXAMPLE affected-package' : '官方卸载命令完成')
    const verification = result.children.find(child => child.tag === 'section')
    assert.equal(verification.children.find(child => child.label === '剩余问题').value, 'fresh verification failed')
  }
})
