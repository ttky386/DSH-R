import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRepairPresentation, recordedChanges, parseConfigurationIssue, waitingServiceEvidence } from '../src/repair-evidence.js'

const component = '@deepseek-ai/dsh-host-product-telemetry-otel'
const target = { home: '/isolated', profile: 'desktop', version: '1.0.0' }
const action = { id: 'config-readonly', component, kind: 'unsupported', source: '/adapter', backup: '/backup', targetVersion: '1.0.0' }
const report = { failed: [{ id: 'desktop-product-telemetry', package: component, reason: '$.serviceVersion missing required value' }], rejected: [], blockingChains: [], waiting: [] }

test('configuration classification uses validator evidence without plugin-specific rules or echoing values', () => {
  assert.equal(parseConfigurationIssue('ValidationError: $.path expected string but got 42').kind, 'type')
  assert.equal(parseConfigurationIssue('ValidationError: $.port expected number >= 1 but got 0').kind, 'range')
  assert.equal(parseConfigurationIssue('ValidationError: $.mode expected "a" | "b" but got secret-value').kind, 'enum')
  assert.equal(parseConfigurationIssue('ValidationError: $.path missing required value').kind, 'missing')
  assert.equal(parseConfigurationIssue('ValidationError: $.path unusual validation failure').kind, 'validation')
  assert.deepEqual(parseConfigurationIssue('ValidationError: invalid config'), { kind: 'validation', field: null, source: 'validator_log' })
  assert.equal(parseConfigurationIssue('network unavailable'), null)
  assert.doesNotMatch(JSON.stringify(parseConfigurationIssue('ValidationError: $.secret expected number but got secret-value')), /secret-value/)
})

test('waiting relations prove service consumers only, preserving required unknown and incomplete closure', () => {
  const relations = waitingServiceEvidence({ waiting: [{ id: 'reader', missing: ['query'] }, { id: 'controller', missing: ['query'], required: true }, { id: 'scheduler', missing: ['controller'], required: false }] })
  assert.equal(relations.length, 2)
  assert.equal(relations[0].service, 'query')
  assert.equal(relations[0].consumers[0].required, null)
  assert.equal(relations[0].consumers[1].required, true)
  assert.equal(relations[0].provider, null)
  assert.equal(relations[0].completeClosure, false)
  const result = buildRepairPresentation([{ id: 'a', component: 'a', kind: 'unsupported' }, { id: 'b', component: 'b', kind: 'unsupported' }], { failed: [{ id: 'a', reason: 'ValidationError: invalid config' }, { id: 'b', reason: 'unrelated error' }], waiting: [{ id: 'reader', missing: ['query'] }] }, {}, target)
  assert.equal(result.problems[0].classification.kind, 'configuration')
  assert.equal(result.waitingServices.length, 1)
  assert.ok(result.problems.every(problem => !Object.hasOwn(problem, 'waiting')))
  const confirmed = waitingServiceEvidence({ waiting: [{ id: 'reader', package: 'example-reader', missing: ['query'] }], runtimeEvidence: { rows: [{ id: 'reader', component: 'example-reader', state: 'pending', required: false }] } })
  assert.equal(confirmed[0].consumers[0].required, false)
  assert.equal(confirmed[0].consumers[0].requiredSource, 'official_runtime_audit')
})

test('problem classification cites current observations and changes with actual blocking evidence', () => {
  const solo = buildRepairPresentation([action], report, {}, target)
  assert.equal(solo.problems[0].classification.kind, 'configuration')
  assert.equal(solo.problems[0].observations[0].field, 'serviceVersion')
  assert.equal(solo.problems[0].blocking, undefined)
  assert.ok(solo.problems[0].unknowns.length)
  assert.equal(solo.problems[0].dependencies.length, 0)
  const mixed = buildRepairPresentation([action], { ...report, blockingChains: [{ id: 'connection', service: 'credentials' }] }, {}, target)
  assert.equal(mixed.problems[0].blocking, undefined)
  const unknown = buildRepairPresentation([action], { ...report, failed: [{ id: 'different', package: component, reason: 'network unavailable' }] }, {}, target)
  assert.equal(unknown.problems[0].classification.kind, 'plugin')
  assert.equal(unknown.problems[0].observations[0].field, undefined)
  assert.doesNotMatch(JSON.stringify(unknown), /残留|不是.*主因|serviceVersion/)
})

test('unconfirmed package source does not become a proven responsibility or dependency', () => {
  const packageAction = { id: 'package', kind: 'package', component: '@deepseek-ai/example', disabledReason: 'unknown source' }
  const result = buildRepairPresentation([packageAction], { ...report, failed: [], rejected: [{ id: 'row', package: '@deepseek-ai/example@1.0.0', runtime: '2.0.0', requirements: '{}' }] }, { packages: [{ name: packageAction.component, disabledReason: 'unknown source', selected: { dir: '/candidate', version: '1.0.0' } }] }, target)
  assert.equal(result.problems[0].confirmations.length, 0)
  assert.equal(result.problems[0].classification.ruleId, 'loader_rejection')
  assert.ok(result.problems[0].unknowns.some(item => item.code === 'source_unconfirmed'))
})

test('history uses recorded changes, never proposal text, and interrupted legacy history stays unknown', () => {
  const legacy = recordedChanges({ status: 'interrupted', action: { ...action, recommendation: '二选一：建议补配置' } })
  assert.equal(legacy.changes.length, 0)
  assert.ok(legacy.unknowns.length)
  const modern = recordedChanges({ status: 'applied', action: { ...action, recommendation: '二选一' }, actualChanges: [{ operation: 'set_launch_variable', path: '/adapter', before: null, after: { variable: 'DSH_CLIENT_VERSION', value: '1.0.0' } }] })
  assert.equal(modern.changes[0].after.value, '1.0.0')
  assert.doesNotMatch(JSON.stringify(modern), /二选一|建议/)
})

test('spawn presence is not proof of config source; unsupported failures retain their actual row facts', () => {
  const result = buildRepairPresentation([action], { ...report, context: { clientVersionPresent: false } }, {}, target)
  assert.equal(result.problems[0].confirmations.some(item => item.kind === 'launch_variable_presence'), false)
  assert.ok(result.problems[0].unknowns.some(item => item.code === 'source_unconfirmed'))
  const unsupported = buildRepairPresentation([{ id: 'unsupported', component: 'custom-row', kind: 'unsupported', disabledReason: 'no verified action' }], { failed: [{ id: 'custom-row', reason: '$.endpoint missing required value' }] }, {}, target)
  assert.equal(unsupported.problems[0].observations[0].rowId, 'custom-row')
  assert.equal(unsupported.problems[0].classification.kind, 'configuration')
  assert.equal(unsupported.actions[0].solution.steps.length, 0)
  assert.equal(unsupported.actions[0].solution.rollback, null)
  assert.equal(unsupported.actions[0].solution.effects.restart, false)
})
