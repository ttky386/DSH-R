import test from 'node:test'
import assert from 'node:assert/strict'
import { createStartupDiagnosis, parseActivation } from '../src/startup-diagnosis.js'

test('flat report ends at its declared rows, not at the end of accumulated logs', () => {
  const collector = createStartupDiagnosis()
  for (const line of [
    'dsh: warning: 1 entry did not activate',
    'reader (pkg-reader): pending (waiting for service: database)',
    'INFO: Connected to backend',
    'Error: A later transport retry',
  ]) {
    collector.addLine(line)
  }
  const report = collector.report()
  assert.deepEqual(report.failed, [])
  assert.equal(report.waiting.length, 1)
  assert.ok(report.evidence.some(item => item.text === 'Error: A later transport retry'))
})

test('latest incomplete report cannot reuse old plugin rows or ordinary log lines', () => {
  const text = [
    'dsh: warning: 1 entry did not activate',
    'old (old-plugin): Error: old failure',
    'dsh: warning: 2 entries did not activate',
    'new (new-plugin): Error: current failure',
    'INFO: unrelated status',
  ].join('\n')
  const result = parseActivation(text)
  assert.deepEqual(result.entries.map(row => row.id), ['new'])
  assert.equal(result.truncated, true)
})

test('later zero report clears old rows and an actual unknown package remains identifiable', () => {
  assert.equal(parseActivation('dsh: warning: 1 entry did not activate\nold (pkg): Error: old\ndsh: warning: 0 entries did not activate'), null)
  const result = parseActivation('dsh: warning: 2 entries did not activate\nreader (pkg): pending (waiting for service: database)\nunknown-plugin (unknown-package): Error: real failure\nother (not-in-report): ordinary output')
  assert.deepEqual(result.entries.map(row => row.id), ['reader', 'unknown-plugin'])
})

test('new report does not inherit an old required marker or nested validation reason', () => {
  const collector = createStartupDiagnosis()
  for (const line of [
    'dsh: startup failed: 1 required plugin did not activate',
    'Failed plugins (1):',
    '  same (required)',
    '    Package: plugin',
    '    ValidationError: invalid config:',
    '      - $.old missing required value',
    'dsh: warning: 1 entry did not activate',
    'same (plugin): ValidationError: invalid config:',
    '  - $.current missing required value',
  ]) {
    collector.addLine(line)
  }
  const row = collector.report().failed[0]
  assert.equal(row.required, undefined)
  assert.match(row.reason, /current/)
  assert.doesNotMatch(row.reason, /old/)
})

test('grouped pending report respects section count and marks incomplete reports', () => {
  const prefix = 'dsh: startup failed: 1 required plugin did not activate\nPlugins waiting for services (1):\n  Plugin       Missing services\n'
  const result = parseActivation(prefix + '  reader (required)  database\n  unrelated  ordinary status')
  assert.deepEqual(result.entries.map(row => row.id), ['reader'])
  assert.equal(parseActivation(prefix).truncated, true)
})
