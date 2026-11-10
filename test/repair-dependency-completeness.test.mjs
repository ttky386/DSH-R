import test from 'node:test'
import assert from 'node:assert/strict'
import { dependencyRemovalScope } from '../src/repair-dependencies.js'
import { join, relative } from 'node:path'

function fixture() {
  const profile = join(process.cwd(), 'memory-only-profile')
  const owner = { manifest: { dependencies: { provider: '1.0.0' } }, name: 'owner', version: '1.0.0', dir: join(profile, 'node_modules/owner') }
  const provider = { manifest: {}, name: 'provider', version: '1.0.0', dir: join(profile, 'node_modules/provider') }
  const state = {
    profile,
    manifest: { dependencies: { owner: '1.0.0' } },
    packages: [owner, provider],
    parsedLayout: { hoistedLocations: Object.fromEntries([owner, provider].map(entry => [`${entry.name}@1.0.0`, [relative(profile, entry.dir).replaceAll('\\', '/')]])) },
    parsedLock: { snapshots: { 'owner@1.0.0': { dependencies: { provider: '1.0.0' } }, 'provider@1.0.0': {} } },
  }
  function resolvePackage(name) {
    return state.packages.find(entry => entry.name === name) || null
  }
  return { state, owner, resolvePackage }
}

test('unresolved direct root refuses to certify an exclusive removal closure', () => {
  const item = fixture()
  item.state.manifest.dependencies['missing-root'] = '1.0.0'
  item.state.parsedLock.snapshots['missing-root@1.0.0'] = { dependencies: { provider: '1.0.0' } }
  assert.throws(() => dependencyRemovalScope(item.state, item.owner, item.resolvePackage), /missing-root/)
})

test('missing lock dependency is uncertainty, including an unproven optional absence', () => {
  for (const field of ['dependencies', 'optionalDependencies']) {
    const item = fixture()
    item.state.parsedLock.snapshots['owner@1.0.0'][field] = { ...item.state.parsedLock.snapshots['owner@1.0.0'][field], missing: '1.0.0' }
    assert.throws(() => dependencyRemovalScope(item.state, item.owner, item.resolvePackage), /missing/)
  }
})

test('complete exclusive closure and another installed root retain normal decisions', () => {
  const item = fixture()
  assert.deepEqual(dependencyRemovalScope(item.state, item.owner, item.resolvePackage).predicted.map(entry => entry.name), ['owner', 'provider'])
  item.state.manifest.dependencies.provider = '1.0.0'
  item.state.parsedLock.importers = { '.': { dependencies: { provider: { specifier: '1.0.0', version: '1.0.0' } } } }
  assert.deepEqual(dependencyRemovalScope(item.state, item.owner, item.resolvePackage).predicted.map(entry => entry.name), ['owner'])
})

test('a matching inventory package cannot stand in for unresolved or different actual resolution', () => {
  const item = fixture()
  assert.throws(() => dependencyRemovalScope(item.state, item.owner, () => null), /provider/)
  assert.throws(() => dependencyRemovalScope(item.state, item.owner, () => ({ name: 'provider', version: '2', dir: '/elsewhere/provider' })), /provider/)
})

test('complete 63-package installed closure remains eligible evidence', () => {
  const item = fixture()
  for (let index = 2; index < 63; index += 1) {
    const name = `dependency-${index}`
    const entry = { manifest: {}, name, version: '1.0.0', dir: join(item.state.profile, 'node_modules', name) }
    item.state.packages.push(entry)
    item.state.parsedLayout.hoistedLocations[`${name}@1.0.0`] = [relative(item.state.profile, entry.dir).replaceAll('\\', '/')]
    item.state.parsedLock.snapshots[`${name}@1.0.0`] = {}
    item.state.parsedLock.snapshots['owner@1.0.0'].dependencies[name] = '1.0.0'
  }
  const result = dependencyRemovalScope(item.state, item.owner, item.resolvePackage)
  assert.equal(result.complete, true)
  assert.equal(result.predicted.length, 63)
})

test('direct-root resolved identity must agree with inventory', () => {
  const item = fixture()
  item.state.manifest.dependencies.provider = '1.0.0'
  item.state.parsedLock.importers = { '.': { dependencies: { provider: { specifier: '1.0.0', version: '1.0.0' } } } }
  assert.throws(() => dependencyRemovalScope(item.state, item.owner, name => ({ ...item.resolvePackage(name), version: '2' })), /provider/)
})
