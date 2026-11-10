import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { describeDiagnosticCommandFailure } from '../src/diagnostic-command-error.js'

const samples = JSON.parse(readFileSync(new URL('./command-errors.json', import.meta.url), 'utf8'))

test('sanitized minAge refusal retains every package, publication time and cutoff without bypass advice', () => {
  const result = describeDiagnosticCommandFailure(samples.minAge, 'dsh plugin remove example', 1)
  assert.match(result, /ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION/)
  assert.match(result, /@example\/first-addon@1\.2\.3 was published at 2000-01-02T08:00:00\.000Z/)
  assert.match(result, /example-second-addon@4\.5\.6 was published at 2000-01-02T06:00:00\.000Z/)
  assert.match(result, /minimumReleaseAge cutoff \(2000-01-02T04:00:00\.000Z\)/)
  assert.doesNotMatch(result, /relax the policy|pnpm clean|pnpm install/)
})

test('sanitized store mismatch retains existing and requested store paths', () => {
  const result = describeDiagnosticCommandFailure(samples.store, '卸载插件', 1)
  assert.match(result, /ERR_PNPM_UNEXPECTED_STORE/)
  assert.match(result, /currently linked from the store at .*store-mismatch\\store\\v11/)
  assert.match(result, /now wants to use the store at .*pnpm-home\\store\\v11/)
  assert.doesNotMatch(result, /pnpm config set|pnpm install/)
})

test('arbitrary package names and multiline reasons survive duplicated coloured output', () => {
  const input = '\u001b[31m[ERR_PNPM_EXAMPLE] blocked\u001b[0m\n  @other/new-plugin@9.8.7\n    reason: rejected by configured policy\n  another-package@4.5.6\n\nProgress: resolved 5\n'
  const result = describeDiagnosticCommandFailure(input + input, '卸载', 3)
  assert.equal(result.match(/@other\/new-plugin@9\.8\.7/g)?.length, 1)
  assert.match(result, /reason: rejected by configured policy/)
  assert.match(result, /another-package@4\.5\.6/)
  assert.doesNotMatch(result, /\u001b|Progress:/)
  const suggestion = describeDiagnosticCommandFailure(input + 'Use --accept-risk\ndsh: plugin command failed; diagnostics: trace.json', '卸载', 1)
  assert.doesNotMatch(suggestion, /--accept-risk|diagnostics:/)
})

test('empty and oversized output remains explicit and bounded without inventing a cause', () => {
  assert.match(describeDiagnosticCommandFailure('', '卸载', 7), /退出码 7.*未提供具体原因/)
  const result = describeDiagnosticCommandFailure('Error: ' + 'x'.repeat(150000), '卸载', 1)
  assert.ok(result.length <= 13000)
  assert.match(result, /截断/)
  assert.doesNotMatch(result, /minAge|store/)
})

test('identical continuation reasons remain attached to each different package', () => {
  const input = '[ERR_PNPM_POLICY] two packages rejected\n  package-a@1.0.0\n    reason: Error from configured policy\n  package-b@2.0.0\n    reason: Error from configured policy'
  const result = describeDiagnosticCommandFailure(input + '\n' + input, '卸载插件', 1)
  assert.match(result, /package-a@1\.0\.0\n    reason: Error from configured policy\n  package-b@2\.0\.0\n    reason: Error from configured policy/)
  assert.equal(result.match(/reason: Error from configured policy/g)?.length, 2)
})

test('sanitized error log replay renders multiline uninstall history as text, without executing a command', () => {
  const html = readFileSync(new URL('../src/public/index.html', import.meta.url), 'utf8')
  function element(tag) {
    return {
      tag,
      style: {},
      textContent: '',
      children: [],
      append(...children) {
        this.children.push(...children)
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
    repairPresentation: () => ({ title: 'uninstall', rollback: 'manual rollback' }),
    repairCard: () => element('card'),
    evidenceDetails() {
    },
    recordedChangeText: change => change.path,
    verificationText: () => 'remaining issues',
    document: {
      createElement: element,
      createTextNode: value => ({ tag: '#text', textContent: value }),
    },
  }
  const lineStart = html.indexOf('    function cardLine(')
  const lineEnd = html.indexOf('    function evidenceDetails(', lineStart)
  const historyStart = html.indexOf('    function verificationText(')
  const historyEnd = html.indexOf('    /** 启动这条线', historyStart)
  vm.runInNewContext(html.slice(lineStart, lineEnd) + html.slice(historyStart, historyEnd), context)
  for (const sample of [samples.minAge, samples.store, 'Error: <img src=x onerror=alert(1)>']) {
    cards.children = []
    const error = describeDiagnosticCommandFailure(sample, '卸载插件', 1)
    context.showRepairHistory([{ action: { kind: 'uninstall-introducer' }, target: {}, status: 'uninstall_failed', error, recorded: { changes: [] } }])
    const result = cards.children[0].children.find(child => child.children?.[0]?.textContent === '卸载结果：')
    assert.equal(result.style.whiteSpace, 'pre-wrap')
    assert.equal(result.children[1].tag, '#text')
    assert.equal(result.children[1].textContent, error)
    const buttons = cards.children[0].children.filter(child => child.tag === 'button')
    assert.equal(buttons.length, 1)
    assert.equal(buttons[0].textContent, '重新获取当前诊断')
  }
})
