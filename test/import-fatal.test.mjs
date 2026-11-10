import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RuntimeDiagnostics, importDisableReason, schemaDisableReason } from '../src/runtime-diagnostics.mjs'

test('initialization waiting does not become a settled required failure or a disable target', () => {
  const row = { state: 'failed', unique: true, topLevel: true, leaf: true, required: false, fatalImport: true, importBeforeApply: true, executions: 0, descendants: 0, ownedServices: 0 }
  assert.equal(importDisableReason(row, { phase: 'initializing', requiredDependencyChains: [], requiredInactive: ['connection'] }), '')
  assert.equal(importDisableReason(row, { phase: 'settled', requiredDependencyChains: [], requiredInactive: ['connection'] }), '')
  assert.notEqual(schemaDisableReason(row, { phase: 'initializing', requiredDependencyChains: [], requiredInactive: ['connection'] }), '')
  for (const change of [{ required: true }, { required: null }, { unique: false }, { importBeforeApply: false }, { executions: 1 }, { fatalImport: false }, { leaf: false }, { ownedServices: 1 }]) {
    assert.notEqual(importDisableReason({ ...row, ...change }, { phase: 'initializing', requiredDependencyChains: [], requiredInactive: [] }), '')
  }
})

test('same text cannot impersonate the audited fatal Error and multiple owners are refused', () => {
  const tracker = new RuntimeDiagnostics()
  const error = new Error('artificial import failure')
  const entry = { options: { id: 'sample', name: 'sample-plugin' } }
  tracker.importFailure(entry, error)
  const row = { id: 'sample', component: 'sample-plugin', importBeforeApply: true, selected: { contentDigest: 'verified' } }
  tracker.earlyImportSnapshot = () => ({ phase: 'initializing', rows: [{ ...row, fatalImport: true }], requiredInactive: [], requiredDependencyChains: [] })
  tracker.rememberImportAudit([{ entry, outcome: { kind: 'failed', phase: 'failed to import', error } }], { phase: 'settled', rows: [row], requiredInactive: [] })
  assert.equal(tracker.fatalSnapshot(new Error(error.message)), null)
  assert.equal(tracker.fatalSnapshot(error).rows[0].fatalImport, true)
  tracker.importFailure({ options: entry.options }, error)
  assert.equal(tracker.fatalSnapshot(error), null)
})

test('early fatal proof requires complete current root, unique identity and no apply', () => {
  const directory = mkdtempSync(join(realpathSync.native(tmpdir()), 'd14-import-proof-'))
  try {
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'example-fault', version: '1.0.0', type: 'module' }))
    writeFileSync(join(directory, 'index.js'), 'export function apply() {}\n')
    const tracker = new RuntimeDiagnostics()
    const error = new Error('example failure')
    const rootOptions = { id: 'include' }
    const root = { data: [] }
    const bootstrap = { options: rootOptions, fiber: { state: 2 }, subtree: { root } }
    const tree = { root, store: {}, ctx: { fiber: { entry: bootstrap }, baseUrl: 'file:///isolated/' } }
    root.tree = tree
    const target = { options: { id: 'fault', name: 'example-fault' }, id: 'include:fault', parent: root }
    const waiting = { options: { id: 'connection', name: 'example-connection' }, parent: root, fiber: { state: 0 } }
    root.data.push(target.options, waiting.options)
    tree.store.fault = target
    tree.store.connection = waiting
    const ctx = { loader: { entries: () => [target, waiting] }, registry: { values: () => [] }, reflect: { store: {} }, get: () => ({ packageOf: () => ({ name: 'example-fault', version: '1.0.0', dir: directory }) }) }
    tracker.registerBoot(ctx, ['connection'])
    tracker.registerRoot(ctx, rootOptions)
    tracker.importFailure(target, error)
    const report = tracker.fatalSnapshot(error)
    assert.equal(report.phase, 'initializing')
    assert.deepEqual(report.requiredInactive, ['connection'])
    assert.equal(importDisableReason(report.rows[0], report), '')
    target.fiber = {}
    assert.equal(tracker.fatalSnapshot(error), null)
    delete target.fiber
    root.data.push(target.options)
    assert.equal(tracker.fatalSnapshot(error), null)
    root.data.pop()
    tree.store.extra = waiting
    assert.equal(tracker.fatalSnapshot(error), null)
    delete tree.store.extra
    const original = target.options
    target.options = { ...original }
    assert.equal(tracker.fatalSnapshot(error), null)
    target.options = original
    tracker.rememberImportAudit([{ entry: target, outcome: { kind: 'failed', phase: 'failed to import', error } }], report)
    assert.equal(tracker.fatalSnapshot(error).phase, 'settled')
    original.group = true
    assert.equal(tracker.fatalSnapshot(error), null)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
