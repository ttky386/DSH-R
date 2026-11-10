import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DiagnosticRepairs } from '../src/repair-actions.js'
import { createRepairPlan } from '../src/repair-plan.js'

test('D10 no new environment adaptation or ordinary launch injection', () => {
  assert.equal(DiagnosticRepairs.prototype.launchEnvironment, undefined)
  const source = readFileSync(new URL('../src/repair-actions.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /id: 'client-version', kind: 'client-version'/)
  assert.doesNotMatch(readFileSync(new URL('../src/server.js', import.meta.url), 'utf8'), /diagnosticRepairs\.launchEnvironment/)
  const plan = createRepairPlan({ advice: [{ code: 'telemetry_configuration' }] })
  assert.doesNotMatch(JSON.stringify(plan), /再审阅启动环境适配|配置项修改|恢复这一适配/)
})

test('D10 source evidence survives without a configuration repair option', async () => {
  const { buildRepairPresentation } = await import('../src/repair-evidence.js')
  const component = '@deepseek-ai/dsh-host-product-telemetry-otel'
  const result = buildRepairPresentation([{ id: 'read-only', kind: 'unsupported', component }], {
    failed: [{ id: 'desktop-product-telemetry', package: component, reason: '$.serviceVersion missing required value' }],
    context: { clientVersionPresent: false }, rejected: [], blockingChains: [], waiting: [],
  }, { configurationEvidence: [{ rowId: 'desktop-product-telemetry', component, field: 'serviceVersion', path: '/verified/template.yml', line: 54, confirmed: true, missing: true, environment: { field: 'serviceVersion', variable: 'DSH_CLIENT_VERSION', present: false } }] }, {})
  const confirmations = result.problems[0].confirmations
  assert.equal(confirmations.find(item => item.kind === 'configuration_source').path, '/verified/template.yml')
  assert.equal(confirmations.find(item => item.kind === 'launch_variable_presence').present, false)
  assert.deepEqual(result.actions[0].solution.steps, [])
})

test('D10 same field on a different plugin cannot inherit template provenance', async () => {
  const { buildRepairPresentation } = await import('../src/repair-evidence.js')
  const component = 'unrelated-plugin'
  const result = buildRepairPresentation([{ id: 'read-only', kind: 'unsupported', component }], {
    failed: [{ id: 'other-row', package: component, reason: '$.serviceVersion missing required value' }],
    context: { clientVersionPresent: false }, rejected: [], blockingChains: [], waiting: [],
  }, { configurationEvidence: [{ rowId: 'desktop-product-telemetry', component: '@deepseek-ai/dsh-host-product-telemetry-otel', field: 'serviceVersion', path: '/verified/template.yml', line: 54, confirmed: true, missing: true, environment: { field: 'serviceVersion', variable: 'DSH_CLIENT_VERSION', present: false } }] }, {})
  assert.equal(result.problems[0].confirmations.some(item => item.kind === 'configuration_source' || item.kind === 'launch_variable_presence'), false)
})
