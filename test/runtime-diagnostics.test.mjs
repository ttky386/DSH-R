import test from 'node:test'
import assert from 'node:assert/strict'
import { RuntimeDiagnostics, optionsDigest, readRuntimeEvidence, RUNTIME_EVIDENCE_PREFIX, schemaDisableReason } from '../src/runtime-diagnostics.mjs'
import { diagnosticSource } from '../src/compat/diagnostics.mjs'

function fixture() {
  const tracker = new RuntimeDiagnostics()
  const fiber = { _runner: {}, parent: {} }
  const parent = { tree: { ctx: { baseUrl: 'file:///isolated/' } } }
  const entry = { options: { id: 'fault', name: 'example' }, id: 'include:fault', fiber, parent }
  const bootstrap = { subtree: { root: parent } }
  const ctx = {
    loader: { entries: () => [entry] },
    registry: { values: () => [{ fibers: [fiber] }] },
    reflect: { store: {} },
    get: () => ({ packageOf: () => ({ dir: '/isolated/example', name: 'example', version: '1.0.0' }) }),
  }
  const failures = [{ entry, outcome: { kind: 'failed' } }]
  return { tracker, fiber, entry, ctx, failures, bootstrap }
}

test('runtime distinguishes original schema failure from fake text, executed or retried failure', () => {
  const item = fixture()
  const fake = new Error('ValidationError: missing required value')
  fake[Symbol.for('ValidationError')] = true
  assert.throws(() => item.tracker.validate(item.fiber, () => {
    throw fake
  }))
  assert.equal(item.tracker.snapshot(item.ctx, item.failures, new Set(), item.bootstrap).rows[0].firstSchemaFailure, false)
  const first = fixture()
  const original = first.tracker.schemaError(new Error('schema'))
  assert.throws(() => first.tracker.validate(first.fiber, () => {
    throw original
  }), error => error === original)
  const observed = first.tracker.snapshot(first.ctx, first.failures, new Set(), first.bootstrap)
  assert.equal(observed.rows[0].firstSchemaFailure, true)
  assert.equal(observed.rows[0].topLevel, true)
  first.tracker.execute(first.fiber, first.fiber._runner)
  assert.equal(first.tracker.snapshot(first.ctx, first.failures, new Set(), first.bootstrap).rows[0].firstSchemaFailure, false)
  const broken = new RuntimeDiagnostics()
  broken.state = () => {
    throw new Error('observer unavailable')
  }
  assert.equal(broken.validate({}, () => 42), 42)
  assert.throws(() => broken.validate({}, () => {
    throw original
  }), error => error === original)
})

test('required, descendants, groups and services remain explicit runtime evidence', () => {
  const item = fixture()
  item.entry.options.group = true
  const child = { parent: { fiber: item.fiber } }
  item.ctx.registry.values = () => [{ fibers: [item.fiber, child] }]
  item.ctx.reflect.store[Symbol('owned')] = { fiber: child }
  const report = item.tracker.snapshot(item.ctx, item.failures, new Set([item.entry]), item.bootstrap)
  assert.equal(report.rows[0].leaf, false)
  assert.equal(report.rows[0].required, true)
  assert.equal(report.rows[0].descendants, 1)
  assert.equal(report.rows[0].ownedServices, 1)
  assert.deepEqual(report.requiredInactive, ['fault'])
})

test('unknown source structures do not inject and options changes invalidate evidence', () => {
  assert.equal(diagnosticSource('unknown source', 'cordis'), null)
  const anchor = '\tconst required = new Set(failures.filter(({ entry }) => entry === bootstrapIncludes.get(ctx) || requiredStartupEntryIds.has(entry.options.id)).map(({ entry }) => entry));'
  const boot = anchor + '\n\t\tif (exiting) return;\n\t\texiting = true;\n\tconst includeId = await ctx.loader.create(rootInclude);\n\t\tawait mountRootInclude(ctx, absoluteConfigPath, patches, bareModuleBaseUrl, binName);'
  assert.match(diagnosticSource(boot, 'boot'), /dshDiagnostic.audit/)
  assert.match(diagnosticSource(boot, 'boot'), /if \(exiting\) return;\s+exiting = true;\s+dshDiagnostic.fatal\(err\)/)
  assert.equal(diagnosticSource(boot + anchor, 'boot'), null)
  const cordis = 'if (result.issues) throw new ValidationError(result.issues);\n\t_execute(runner) {\n}\nreturn this.runtime ? resolveConfig(this.runtime, config) : config;'
  const patched = diagnosticSource(cordis + '\n\t\t\tthis.store[key] = impl;\n\tasync _unload() {\n\tasync _reload() {\n', 'cordis')
  assert.match(patched, /validate\(this, \(\) => resolveConfig\(this.runtime, config\), config\)/)
  assert.doesNotMatch(patched, /validate\(this, \(\) => this\._resolveConfig/)
  assert.notEqual(optionsDigest({ config: { path: 42 } }), optionsDigest({ config: { path: 43 } }))
  assert.throws(() => optionsDigest({ config() {
    return 42
  } }), /unverifiable/)
  const nonce = 'a'.repeat(32)
  const line = RUNTIME_EVIDENCE_PREFIX + JSON.stringify({ nonce, rows: [], requiredInactive: [] })
  assert.equal(readRuntimeEvidence(line, 'b'.repeat(32)), null)
  assert.deepEqual(readRuntimeEvidence(line, nonce), { rows: [], requiredInactive: [] })
  const invalidChain = { requiredId: 'connection', targetId: 'fault', edges: [{ from: 'unrelated', to: 'fault', service: 'credentials' }] }
  assert.equal(readRuntimeEvidence(RUNTIME_EVIDENCE_PREFIX + JSON.stringify({ nonce, rows: [], requiredInactive: [], requiredDependencyChains: [invalidChain] }), nonce), null)
})

test('single disable gate rejects waiting, required, unknown, group and already-executed targets', () => {
  const row = { state: 'failed', unique: true, topLevel: true, leaf: true, required: false, firstSchemaFailure: true, executions: 0, descendants: 0, ownedServices: 0 }
  assert.equal(schemaDisableReason(row, { phase: 'settled', requiredDependencyChains: [], requiredInactive: [] }), '')
  for (const change of [{ state: 'pending' }, { required: true }, { required: undefined }, { leaf: false }, { firstSchemaFailure: false }, { executions: 1 }, { descendants: 1 }, { ownedServices: 1 }, { topLevel: false }]) {
    assert.notEqual(schemaDisableReason({ ...row, ...change }, { phase: 'settled', requiredDependencyChains: [], requiredInactive: [] }), '')
  }
  assert.equal(schemaDisableReason(row, { phase: 'settled', requiredDependencyChains: [], requiredInactive: ['connection'] }), '')
  assert.notEqual(schemaDisableReason(row, {}), '')
})

test('actual inactive service binding produces a required chain; unrelated waiting does not', () => {
  const item = fixture()
  item.fiber.state = 0
  const consumerFiber = {
    inject: { credentials: null },
    state: 0,
    ctx: { reflect: { _getImpl: () => ({ fiber: item.fiber }) } },
  }
  const consumer = { options: { id: 'connection', name: 'connection-plugin' }, fiber: consumerFiber, parent: item.entry.parent }
  item.ctx.loader.entries = () => [item.entry, consumer]
  item.ctx.registry.values = () => [{ fibers: [item.fiber, consumerFiber] }]
  const report = item.tracker.snapshot(item.ctx, item.failures, new Set([consumer]), item.bootstrap)
  assert.deepEqual(report.requiredDependencyChains, [{ requiredId: 'connection', targetId: 'fault', edges: [{ from: 'connection', to: 'fault', service: 'credentials' }] }])
  const row = { ...report.rows[0], firstSchemaFailure: true, executions: 0, ownedServices: 0 }
  assert.match(schemaDisableReason(row, report), /实际服务依赖目标/)
  consumerFiber.ctx.reflect._getImpl = () => undefined
  const waiting = item.tracker.snapshot(item.ctx, item.failures, new Set([consumer]), item.bootstrap)
  assert.deepEqual(waiting.requiredDependencyChains, [])
  assert.equal(schemaDisableReason(row, waiting), '')
  item.failures[0].outcome.kind = 'pending'
  consumerFiber.ctx.reflect._getImpl = () => ({ fiber: item.fiber })
  assert.deepEqual(item.tracker.snapshot(item.ctx, item.failures, new Set([consumer]), item.bootstrap).requiredDependencyChains, [])
  item.failures[0].outcome.kind = 'failed'
  consumerFiber.ctx.reflect._getImpl = () => ({ fiber: item.fiber })
  item.fiber.state = 2
  assert.deepEqual(item.tracker.snapshot(item.ctx, item.failures, new Set([consumer]), item.bootstrap).requiredDependencyChains, [])
})

test('dependency traversal preserves entry identity across duplicate local ids', () => {
  const item = fixture()
  item.fiber.state = 0
  const left = { id: 'root:left:same', options: { id: 'same' }, fiber: { state: 0 }, parent: item.entry.parent }
  const right = { id: 'root:right:same', options: { id: 'same' }, fiber: { state: 0, inject: { serviceB: null }, ctx: { reflect: { _getImpl: () => ({ fiber: item.fiber }) } } }, parent: item.entry.parent }
  const connection = { options: { id: 'connection' }, fiber: { inject: { serviceA: null }, ctx: { reflect: { _getImpl: () => ({ fiber: left.fiber }) } } }, parent: item.entry.parent }
  item.ctx.loader.entries = () => [connection, left, right, item.entry]
  item.ctx.registry.values = () => [{ fibers: [connection.fiber, left.fiber, right.fiber, item.fiber] }]
  assert.deepEqual(item.tracker.snapshot(item.ctx, item.failures, new Set([connection]), item.bootstrap).requiredDependencyChains, [])
  left.fiber.inject = right.fiber.inject
  left.fiber.ctx = right.fiber.ctx
  assert.deepEqual(item.tracker.snapshot(item.ctx, item.failures, new Set([connection]), item.bootstrap).requiredDependencyChains, [])
  right.options.id = 'other'
  assert.deepEqual(item.tracker.snapshot(item.ctx, item.failures, new Set([connection]), item.bootstrap).requiredDependencyChains, [{ requiredId: 'connection', targetId: 'fault', edges: [{ from: 'connection', to: 'same', service: 'serviceA' }, { from: 'same', to: 'fault', service: 'serviceB' }] }])
  right.fiber = left.fiber
  assert.deepEqual(item.tracker.snapshot(item.ctx, item.failures, new Set([connection]), item.bootstrap).requiredDependencyChains, [])
})
