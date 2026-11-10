import test from 'node:test'
import assert from 'node:assert/strict'
import { configurationEnvironment, configurationField, declaredService, configurationSources } from '../src/configuration-evidence.js'
import { RuntimeDiagnostics, optionsDigest, schemaDisableReason, readRuntimeEvidence, RUNTIME_EVIDENCE_PREFIX } from '../src/runtime-diagnostics.mjs'
import { buildRepairPresentation } from '../src/repair-evidence.js'

test('direct environment capture records presence only and never evaluates complex expressions', () => {
  const result = configurationEnvironment({ path: { __jsExpr: 'process.env.DATABASE_PATH' }, other: { __jsExpr: 'process.env.SECRET || dangerous()' } }, { DATABASE_PATH: 'private-value', SECRET: 'hidden' })
  assert.deepEqual(result, [{ field: 'path', variable: 'DATABASE_PATH', present: true }, { field: 'other', variable: null, present: null }])
  assert.doesNotMatch(JSON.stringify(result), /private-value|hidden|dangerous/)
  assert.equal(configurationEnvironment({ path: { __jsExpr: 'process.env.UNKNOWN_CONFIG_VARIABLE' } }, {})[0].present, false)
  assert.deepEqual(configurationField({}, 'database.path'), { missing: true })
})

test('configuration evidence attributes the last actual full config replacement, including identical values', () => {
  const initial = { id: 'db', name: 'example-db', config: { path: { __jsExpr: 'process.env.DB_PATH' } } }
  const override = { id: 'db', config: { path: { __jsExpr: 'process.env.DB_PATH' } } }
  const layers = [[{ insert: [initial] }], [override]]
  function compose(input) {
    const rows = []
    for (const patch of input.flat()) {
      if (patch.insert) {
        rows.push(...structuredClone(patch.insert))
      } else {
        const row = rows.find(item => item.id === patch.id && (!patch.name || patch.name === item.name))
        if (row) {
          Object.assign(row, structuredClone(patch))
        }
      }
    }
    return rows
  }
  const composed = compose(layers)
  const observed = [{ id: 'db', component: 'example-db', optionsDigest: optionsDigest(composed[0]), configuration: { field: 'path', missing: true, environment: { field: 'path', variable: 'DB_PATH', present: false } } }]
  const input = { layers, files: [['/bundle.yml', 'a'], ['/profile.yml', 'b']], compose, composed, observed, digest: optionsDigest, emptyRoot: true, locate: () => ({ line: 4, fieldDeclared: true }) }
  const evidence = configurationSources(input)[0]
  assert.equal(evidence.path, '/profile.yml')
  assert.deepEqual(evidence.overridden, ['/bundle.yml'])
  assert.equal(evidence.environment.present, false)
  assert.equal(evidence.source, 'current_composition_matching_attempt')
  assert.equal(configurationSources({ ...input, emptyRoot: false })[0].confirmed, false)
  assert.equal(configurationSources({ ...input, observed: [{ ...observed[0], optionsDigest: 'stale' }] })[0].confirmed, false)
  const guarded = [[{ insert: [initial] }], [{ ...override, name: 'different' }]]
  assert.equal(configurationSources({ ...input, layers: guarded, composed: compose(guarded) })[0].path, '/bundle.yml')
  const replaced = [[{ insert: [initial] }], [{ id: 'db', config: {} }]]
  const replacement = compose(replaced)
  assert.equal(configurationSources({ ...input, layers: replaced, composed: replacement, observed: [{ ...observed[0], optionsDigest: optionsDigest(replacement[0]) }], locate: () => ({ line: 5, fieldDeclared: false }) })[0].fieldDeclared, false)
})

test('service declaration is generic, ignores quoted/comment decoys, rejects conditional/dynamic/inherited names', () => {
  class Service {}
  class Good extends Service {
    constructor(ctx, config) {
      if (!config) {
        throw new Error('configuration')
      }
      // super(ctx, 'decoy');
      const note = "super(ctx, 'anotherDecoy');";
      super(ctx, 'databaseReader');
    }
  }
  assert.equal(declaredService(Good, Service).service, 'databaseReader')
  class Dynamic extends Service {
    constructor(ctx, config) {
      super(ctx, config.service);
    }
  }
  class Conditional extends Service {
    constructor(ctx, config) {
      if (config) {
        super(ctx, 'databaseReader');
      }
    }
  }
  class Child extends Good {}
  class Reassigned extends Service {
    constructor(ctx, config) {
      ctx = config;
      super(ctx, 'databaseReader');
    }
  }
  assert.equal(declaredService(Dynamic, Service), null)
  assert.equal(declaredService(Conditional, Service), null)
  assert.equal(declaredService(Child, Service), null)
  assert.equal(declaredService(Reassigned, Service), null)
})

function runtimeFixture() {
  const tracker = new RuntimeDiagnostics()
  class Service {}
  class Provider extends Service {
    constructor(ctx, config) {
      super(ctx, 'databaseReader');
    }
  }
  const symbol = Symbol('isolate')
  const key = Symbol('databaseReader')
  const store = {}
  const root = { [symbol]: Object.create(null) }
  const context = () => ({ root, reflect: { store, _getImpl: () => undefined }, [symbol]: { databaseReader: key } })
  tracker.registerServiceClass(Service, symbol)
  const config = { path: { __jsExpr: 'process.env.DSH_TEST_ABSENT_DATABASE_PATH' } }
  const fiber = { runtime: { callback: Provider }, ctx: context(), _config: config, _runner: {}, inject: {} }
  const entry = { options: { id: 'db', name: 'example-db', config }, fiber }
  const consumer = { options: { id: 'reader', name: 'example-reader' }, fiber: { ctx: context(), inject: { databaseReader: {} }, _store: {} } }
  tracker.configurationStart(fiber)
  const error = tracker.schemaError(new Error('ValidationError: $.path missing required value'))
  assert.throws(() => tracker.validate(fiber, () => { throw error }, {}))
  const failures = [{ entry, outcome: { kind: 'failed', error } }, { entry: consumer, outcome: { kind: 'pending' } }]
  return { tracker, fiber, entry, consumer, failures, symbol, key }
}

test('same-attempt validation capture preserves absence and service declaration only connects actual scoped waiting', () => {
  const item = runtimeFixture()
  assert.equal(item.tracker.state(item.fiber).configuration.missing, true)
  assert.equal(item.tracker.state(item.fiber).configuration.environment.present, false)
  const evidence = item.tracker.declarationEvidence([item.entry, item.consumer], item.failures)
  assert.equal(evidence[0].unregistered, true)
  assert.equal(evidence[0].consumers[0].id, 'reader')
  const duplicateId = { ...item.entry }
  assert.deepEqual(item.tracker.declarationEvidence([item.entry, item.consumer, duplicateId], item.failures), [])
  const sameConsumer = { ...item.consumer }
  assert.deepEqual(item.tracker.declarationEvidence([item.entry, item.consumer, sameConsumer], item.failures)[0].consumers, [])
  item.consumer.fiber.ctx[item.symbol].databaseReader = Symbol('other-scope')
  assert.deepEqual(item.tracker.declarationEvidence([item.entry, item.consumer], item.failures)[0].consumers, [])
  item.consumer.fiber.ctx[item.symbol].databaseReader = item.key
  const duplicate = { ...item.entry, options: { ...item.entry.options, id: 'duplicate' }, fiber: { ...item.fiber } }
  assert.match(item.tracker.declarationEvidence([item.entry, item.consumer, duplicate], item.failures)[0].reason, /唯一/)
  item.tracker.execute(item.fiber, item.fiber._runner)
  assert.deepEqual(item.tracker.declarationEvidence([item.entry, item.consumer], item.failures), [])
})

test('unallocated public service scope requires the same root inheritance and rejects shadowed absence', () => {
  const tracker = new RuntimeDiagnostics()
  const symbol = Symbol('isolate')
  const rootMap = Object.create(null)
  const root = { [symbol]: rootMap }
  tracker.isolateSymbol = symbol
  const provider = { root, [symbol]: Object.create(rootMap) }
  const consumer = { root, [symbol]: Object.create(provider[symbol]) }
  assert.equal(tracker.declarationScope(provider, 'databaseReader'), rootMap)
  assert.equal(tracker.declarationScope(consumer, 'databaseReader'), rootMap)
  consumer[symbol].databaseReader = undefined
  assert.equal(tracker.declarationScope(consumer, 'databaseReader'), null)
  delete consumer[symbol].databaseReader
  Object.defineProperty(consumer[symbol], 'databaseReader', { get() { throw new Error('must not evaluate') } })
  assert.equal(tracker.declarationScope(consumer, 'databaseReader'), null)
  assert.equal(tracker.declarationScope({ root, [symbol]: Object.create(null) }, 'databaseReader'), null)
  const isolated = Symbol('isolated')
  assert.equal(tracker.declarationScope({ root, [symbol]: { databaseReader: isolated } }, 'databaseReader'), isolated)
})

test('actual ValidationError name identifies type failures without writing the name in its message', () => {
  const tracker = new RuntimeDiagnostics()
  const fiber = { _config: { path: 42 } }
  tracker.configurationStart(fiber)
  const error = new Error('$.path expected string but got 42')
  error.name = 'ValidationError'
  tracker.schemaError(error)
  assert.throws(() => tracker.validate(fiber, () => { throw error }, { path: 42 }))
  assert.deepEqual(tracker.state(fiber).configuration, { field: 'path', missing: false, environment: null })
})

test('presentation exposes generic field/source/absence and inferred declaration chain without changing actions', () => {
  const action = { component: 'example-db', kind: 'unsupported', disabledReason: 'unchanged' }
  const report = { failed: [{ id: 'db', package: 'example-db', reason: 'ValidationError: $.path missing required value' }], waiting: [{ id: 'reader', package: 'example-reader', missing: ['databaseReader'] }], runtimeEvidence: { declarationEvidence: [{ id: 'db', component: 'example-db', service: 'databaseReader', source: 'loaded_constructor_declaration', unregistered: true, consumers: [{ id: 'reader', component: 'example-reader' }] }] } }
  const inspected = { configurationEvidence: [{ rowId: 'db', component: 'example-db', confirmed: true, path: '/profile.yml', line: 4, field: 'path', missing: true, environment: { variable: 'DATABASE_PATH', present: false } }] }
  const result = buildRepairPresentation([action], report, inspected, {})
  assert.equal(result.problems[0].confirmations.find(item => item.kind === 'configuration_source').path, '/profile.yml')
  assert.equal(result.problems[0].confirmations.find(item => item.kind === 'launch_variable_presence').present, false)
  assert.equal(result.waitingServices[0].declarations[0].id, 'db')
  assert.equal(result.waitingServices[0].provider, null)
  assert.equal(action.disabledReason, 'unchanged')
  assert.deepEqual(action.solution.steps, [])
  const safe = { state: 'failed', unique: true, topLevel: true, leaf: true, required: false, firstSchemaFailure: true, executions: 0, descendants: 0, ownedServices: 0 }
  assert.equal(schemaDisableReason(safe, { phase: 'settled', requiredDependencyChains: [], declarationEvidence: report.runtimeEvidence.declarationEvidence }), '')
  assert.notEqual(schemaDisableReason({ ...safe, state: 'pending' }, { phase: 'settled', requiredDependencyChains: [] }), '')
})

test('malformed optional display metadata does not remove original safety snapshot', () => {
  const nonce = 'a'.repeat(32)
  const parsed = readRuntimeEvidence(RUNTIME_EVIDENCE_PREFIX + JSON.stringify({ nonce, rows: [{ id: 'db', component: 'example-db', configuration: { field: 42 } }], requiredInactive: [], requiredDependencyChains: [], declarationEvidence: [{}] }), nonce)
  assert.equal(parsed.rows[0].configuration, undefined)
  assert.equal(parsed.declarationEvidence, undefined)
  assert.deepEqual(parsed.requiredDependencyChains, [])
  const clean = readRuntimeEvidence(RUNTIME_EVIDENCE_PREFIX + JSON.stringify({ nonce, rows: [{ id: 'db', component: 'example-db', configuration: { field: 'path', missing: true, value: 'secret', environment: { field: 'path', variable: 'DB_PATH', present: false, value: 'secret' } } }], requiredInactive: [], declarationEvidence: [{ id: 'db', component: 'example-db', service: 'databaseReader', reason: '', unregistered: true, source: 'loaded_constructor_declaration', constructorDigest: 'a'.repeat(64), value: 'secret', consumers: [{ id: 'reader', component: 'example-reader', value: 'secret' }] }] }), nonce)
  assert.doesNotMatch(JSON.stringify(clean), /secret|"value"/)
  assert.equal(clean.declarationEvidence[0].unregistered, true)
})
