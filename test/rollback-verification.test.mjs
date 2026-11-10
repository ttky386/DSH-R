import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

test('verification status distinguishes active, completed and missing evidence', () => {
  const html = readFileSync(new URL('../src/public/index.html', import.meta.url), 'utf8')
  const start = html.indexOf('    function verificationText(')
  assert.notEqual(start, -1)
  const end = html.indexOf('    function showRepairHistory', start)
  const context = { t: value => value }
  vm.runInNewContext(html.slice(start, end) + '\nthis.label = verificationText', context)
  assert.match(context.label({}, true), /复验中/)
  assert.match(context.label({ outcome: { status: 'resolved', bypassed: true } }), /复验通过/)
  assert.equal(context.label({ outcome: { status: 'partial' } }), '复验完成：仍有问题，启动状态未记录。')
  assert.equal(context.label({ outcome: { status: 'unresolved' } }), '复验完成：仍有问题，启动状态未记录。')
  assert.equal(context.label({ outcome: { status: 'partial', ready: true, alive: true } }), '复验完成：已恢复启动，仍有下列插件问题。')
  assert.equal(context.label({ outcome: { status: 'unresolved', ready: true, alive: false } }), '复验完成：尚未恢复启动。')
  assert.equal(context.label({ outcome: { status: 'unresolved', ready: false, alive: false } }), '复验完成：尚未恢复启动。')
  assert.match(context.label({ verificationStatus: 'pending', outcome: { status: 'resolved' } }), /尚未完成/)
  assert.match(context.label({ verificationStatus: 'failed' }), /未完成/)
  assert.match(context.label({}), /缺少复验结果/)
  assert.match(context.label({ status: 'rolled_back', outcome: { status: 'resolved', bypassed: true } }), /缺少可信/)
})
