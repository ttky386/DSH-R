import test from 'node:test'
import assert from 'node:assert/strict'
import { assessIntroducer, dependencyOrigins, packageStateChanges } from '../src/repair-dependencies.js'
import { join } from 'node:path'

function fixture() {
  return {
    owner: { name: 'renamed-reviewer', version: '2.3.4', dir: '/profile/node_modules/renamed-reviewer', direct: true, installed: true, field: 'dependencies' },
    owners: [{ name: 'renamed-reviewer', dir: '/profile/node_modules/renamed-reviewer', field: 'dependencies' }],
    entries: [{ id: 'reviewer', name: 'renamed-reviewer', disabled: true, required: false }],
    sourceConfirmed: true,
    fallbackConfirmed: true,
    graphComplete: true,
  }
}

test('a renamed disabled direct introducer is supported without sample-specific rules', () => {
  assert.equal(assessIntroducer(fixture()), '')
})

test('another installed consumer blocks removal even when it is disabled', () => {
  const input = fixture()
  input.owners.push({ name: 'another-consumer', dir: '/profile/node_modules/another-consumer', field: 'dependencies' })
  assert.match(assessIntroducer(input), /其他/)
})

test('an observed consumer with missing lock proof is uncertainty, not absence', () => {
  const input = fixture()
  input.owners.push({ name: 'untracked-consumer', dir: '/profile/node_modules/untracked-consumer', field: 'dependencies', installed: false })
  assert.match(assessIntroducer(input), /其他/)
})

test('only verified consumers inside the exclusive removal closure are internal', () => {
  const input = fixture()
  const internal = { dir: '/profile/node_modules/internal', installed: true }
  input.owners.push(internal)
  input.removedDirectories = [internal.dir]
  assert.equal(assessIntroducer(input), '')
  internal.installed = false
  assert.match(assessIntroducer(input), /其他/)
  internal.installed = true
  input.removedDirectories = []
  assert.match(assessIntroducer(input), /其他/)
})

test('new configuration files created by package management are recorded', () => {
  const profile = join(process.cwd(), 'fixture-profile')
  const path = join(profile, 'cordis.patch.yml')
  const before = { profile, packages: [], files: [] }
  const after = { profile, packages: [], files: [{ path, digest: 'new-file' }] }
  assert.deepEqual(packageStateChanges(before, after), [{ operation: 'installation_manifest_changed', path, before: { digest: null }, after: { digest: 'new-file' } }])
})

test('peer declarations alone never establish the introducer', () => {
  const input = fixture()
  input.owner.field = 'peerDependencies'
  assert.match(assessIntroducer(input), /peer/)
})

test('enabled, required, uncertain source and missing fallback remain blocked', () => {
  for (const field of ['sourceConfirmed', 'fallbackConfirmed', 'graphComplete']) {
    const input = fixture()
    input[field] = false
    assert.notEqual(assessIntroducer(input), '')
  }
  for (const entries of [[], [{ name: 'renamed-reviewer', disabled: false }], [{ name: 'renamed-reviewer', disabled: true, required: true }]]) {
    assert.notEqual(assessIntroducer({ ...fixture(), entries }), '')
  }
})

test('lock, Windows hoisted layout and exact resolver path must all agree', () => {
  const profile = join(process.cwd(), 'fixture-profile')
  const owner = { name: 'other-reviewed-plugin', version: '3.0.0', dir: join(profile, 'node_modules/other-reviewed-plugin'), manifest: { dependencies: { 'old-provider': '1.0.0' } } }
  const target = { name: 'old-provider', selected: { version: '1.0.0', dir: join(profile, 'node_modules/old-provider') } }
  const state = {
    profile,
    packages: [owner],
    manifest: { dependencies: { 'other-reviewed-plugin': '3.0.0' } },
    lock: JSON.stringify({ importers: { '.': { dependencies: { 'other-reviewed-plugin': { version: '3.0.0' } } } }, snapshots: { 'other-reviewed-plugin@3.0.0': { dependencies: { 'old-provider': '1.0.0' } } } }),
    layout: JSON.stringify({ nodeLinker: 'hoisted', hoistedLocations: { 'other-reviewed-plugin@3.0.0': ['node_modules\\other-reviewed-plugin'] } }),
  }
  const resolver = () => ({ dir: target.selected.dir, version: '1.0.0' })
  assert.equal(dependencyOrigins(state, profile, target, resolver, JSON.parse)[0].installed, true)
  assert.deepEqual(dependencyOrigins(state, profile, target, () => ({ dir: join(profile, 'another-copy'), version: '1.0.0' }), JSON.parse), [])
  state.parsedLock.snapshots['other-reviewed-plugin@3.0.0'].dependencies['old-provider'] = '2.0.0'
  assert.equal(dependencyOrigins(state, profile, target, resolver, JSON.parse)[0].installed, false)
})
