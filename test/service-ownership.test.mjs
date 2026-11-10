import test from 'node:test'
import assert from 'node:assert/strict'
import { RuntimeDiagnostics, schemaDisableReason } from '../src/runtime-diagnostics.mjs'

function fixture() {
  const tracker = new RuntimeDiagnostics()
  const root = {}
  const error = new Error('actual initialization failure')
  const parent = { tree: { ctx: { baseUrl: 'file:///isolated/' } } }
  const provider = { state: 3, _runner: {}, _error: error, parent: {} }
  const consumer = { state: 0, _runner: {}, inject: { credentials: null }, _store: {}, parent: {} }
  const store = {}
  const key = Symbol('credentials')
  const isolateSymbol = Symbol('isolate')
  const impl = { fiber: provider, name: 'credentials' }
  store[key] = impl
  const reflect = { store, _getImpl: () => store[key] }
  const ctx = { root, reflect, [isolateSymbol]: { credentials: key }, get: () => null }
  provider.ctx = { ...ctx }
  consumer.ctx = { ...ctx }
  const entry = { id: 'root:provider', options: { id: 'provider', name: 'official-provider' }, fiber: provider, parent }
  const dependent = { id: 'root:connection', options: { id: 'connection', name: 'official-consumer' }, fiber: consumer, parent }
  ctx.loader = { entries: () => [entry, dependent] }
  ctx.registry = { values: () => [{ fibers: [provider, consumer] }] }
  provider.ctx.registry = ctx.registry
  provider.ctx.loader = ctx.loader
  const failures = [{ entry, outcome: { kind: 'failed', error } }, { entry: dependent, outcome: { kind: 'pending' } }]
  const snapshot = () => tracker.snapshot(ctx, failures, new Set([dependent]), {})
  const capture = () => {
    tracker.serviceProvided(reflect, key, impl)
    tracker.beforeUnload(provider, isolateSymbol)
    delete store[key]
  }
  return { tracker, provider, consumer, ctx, entry, dependent, failures, snapshot, capture, reflect, key, impl, isolateSymbol }
}

test('actual binding survives failure cleanup and rejects disabling its required provider', () => {
  const item = fixture()
  item.capture()
  const report = item.snapshot()
  assert.deepEqual(report.requiredDependencyChains, [{ requiredId: 'connection', targetId: 'provider', edges: [{ from: 'connection', to: 'provider', service: 'credentials' }] }])
  assert.match(schemaDisableReason(report.rows[0], report), /实际服务依赖目标/)
})

test('root include ancestor does not hide a direct owner and duplicate direct owners remain unknown', () => {
  const item = fixture()
  const ancestor = { options: { id: 'include' }, fiber: {} }
  item.provider.parent.fiber = ancestor.fiber
  item.ctx.loader.entries = () => [ancestor, item.entry, item.dependent]
  item.capture()
  assert.equal(item.snapshot().requiredDependencyChains.length, 1)
  item.ctx.loader.entries = () => [ancestor, item.entry, { ...item.entry }, item.dependent]
  assert.deepEqual(item.snapshot().requiredDependencyChains, [])
})

test('negative control detects missing pre-cleanup observation without relying on a missing method', () => {
  const item = fixture()
  item.tracker.beforeUnload = () => {
  }
  item.capture()
  assert.throws(() => assert.equal(item.snapshot().requiredDependencyChains.length, 1), { code: 'ERR_ASSERTION' })
})

test('cleanup evidence expires on retry, replacement, changed identities or changed failure', () => {
  const changes = [
    item => {
      item.tracker.reload(item.provider)
    },
    item => {
      item.tracker.reload(item.consumer)
    },
    item => {
      item.tracker.validate(item.provider, () => ({}))
    },
    item => {
      item.provider._runner = {}
    },
    item => {
      item.consumer._runner = {}
    },
    item => {
      item.entry.options = { ...item.entry.options }
    },
    item => {
      item.dependent.options.config = { changed: true }
    },
    item => {
      item.entry.fiber = { ...item.provider }
    },
    item => {
      item.failures[0].outcome.error = new Error('another failure')
    },
    item => {
      item.ctx.root = {}
    },
    item => {
      item.consumer.ctx[item.isolateSymbol] = { credentials: Symbol('credentials') }
    },
    item => {
      item.consumer.ctx.root = undefined
    },
    item => {
      item.tracker.serviceProvided(item.reflect, item.key, { fiber: {}, name: 'credentials' })
    },
  ]
  for (const change of changes) {
    const item = fixture()
    item.capture()
    change(item)
    assert.deepEqual(item.snapshot().requiredDependencyChains, [])
  }
})

test('pure pending, unknown ownership and successful unload never establish failure chains', () => {
  for (const mode of ['pending', 'unknown', 'success']) {
    const item = fixture()
    if (mode === 'pending') {
      item.failures[0].outcome.kind = 'pending'
    }
    if (mode === 'unknown') {
      item.reflect._getImpl = () => undefined
    }
    if (mode === 'success') {
      item.provider._error = undefined
    }
    item.capture()
    assert.deepEqual(item.snapshot().requiredDependencyChains, [])
  }
})
