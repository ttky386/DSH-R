import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import * as diagnosis from '../src/startup-diagnosis.js'

const baseline = JSON.parse(readFileSync(new URL('./fixtures/nexus-diagnosis-samples.json', import.meta.url), 'utf8'))
const realLog = readFileSync(new URL('./fixtures/startup-desktop-sanitized.txt', import.meta.url), 'utf8')

test('Nexus 已验证样例的完整输出对拍', () => {
  for (const sample of baseline.samples) {
    assert.deepEqual(diagnosis[sample.fn](sample.input), sample.expected, sample.input)
  }
})

test('脱敏故障样例分开显示直接失败、拒绝条目和等待项，保留嵌套原因', () => {
  const collector = diagnosis.createStartupDiagnosis({ profile: 'desktop', version: '0.2.1-rc.2', entry: '/runtime/lib/bin.js', clientVersionPresent: false })
  for (const line of realLog.split('\n')) {
    collector.addLine(line)
  }
  for (let index = 0; index < 500; index += 1) {
    collector.addLine(`ordinary output ${index}`)
  }
  const report = collector.report()
  assert.equal(report.failed.length, 1)
  assert.match(report.failed[0].reason, /serviceVersion missing required value/)
  assert.equal(report.waiting.length, 32)
  assert.equal(report.rejected.length, 11)
  assert.equal(report.skipped.entries.length, 3)
  assert.equal(report.context.entry, '/runtime/lib/bin.js')
  assert.ok(report.advice.some(item => item.code === 'telemetry_configuration'))
  assert.ok(report.advice.some(item => item.code === 'incompatible_packages'))
  assert.ok(report.advice.some(item => item.code === 'module_interface'))
})

test('未知、截断与独立启动不制造根因，收集量有界', () => {
  const first = diagnosis.createStartupDiagnosis({ profile: 'web' })
  first.addLine('Something unexpected happened')
  assert.equal(first.report().primary.code, 'unknown')
  const second = diagnosis.createStartupDiagnosis({ profile: 'desktop' })
  assert.equal(second.report().failed.length, 0)
  for (let index = 0; index < 2000; index += 1) {
    first.addLine(`Error: ${index} ${'x'.repeat(9000)}`)
  }
  assert.equal(first.report().truncated, true)
  assert.ok(JSON.stringify(first.report()).length < 100000)
  assert.equal(second.report().truncated, false)
})

test('历史日志包装只去外层，保留原始缩进和序号', () => {
  const collector = diagnosis.createStartupDiagnosis({ profile: 'desktop' })
  for (const line of realLog.split('\n')) {
    collector.addLine(`[2000-01-01T00:00:00.000Z] [0.2.1-rc.2/desktop] ${line}`)
  }
  assert.equal(collector.report().waiting.length, 32)
  assert.ok(collector.report().evidence.some(item => item.line > 1 && item.text.includes('serviceVersion')))
})

test('已知秘密在任何长度裁剪前清除，不能留下被裁断的前缀', () => {
  const secret = 'private-credential-that-crosses-the-boundary'
  const collector = diagnosis.createStartupDiagnosis({}, text => text.split(secret).join('[redacted]'))
  collector.addLine(`dsh: warning: 1 entry did not activate`)
  collector.addLine(`plugin (package): ${'x'.repeat(395)}${secret}`)
  collector.addLine(`Error: ${'x'.repeat(3980)}${secret}`)
  assert.ok(!JSON.stringify(collector.report()).includes('private'))
})

test('拒绝条目达到上限时明确标记未完整显示', () => {
  const collector = diagnosis.createStartupDiagnosis()
  for (let index = 0; index < 60; index += 1) {
    collector.addLine(`dsh: disabling profile plugin row "row-${index}": Plugin pkg-${index}@1 is incompatible with dsh 2: requirements {"dsh":"1"}. Running it may fail.`)
  }
  assert.equal(collector.report().rejected.length, 48)
  assert.equal(collector.report().truncated, true)
})
