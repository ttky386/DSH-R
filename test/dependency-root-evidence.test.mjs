import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { dependencyRemovalScope } from '../src/repair-dependencies.js'

function fixture(optional = false) {
  const profile = join(process.cwd(), 'memory-profile')
  const owner = { name: 'owner', version: '1.0.0', dir: join(profile, 'node_modules/owner'), manifest: {} }
  const kept = { name: 'kept', version: '1.0.0', dir: join(profile, 'node_modules/kept'), manifest: {} }
  const field = optional ? 'optionalDependencies' : 'dependencies'
  const state = {
    profile,
    manifest: { dependencies: { owner: '1.0.0' }, [field]: { ...(optional ? {} : { owner: '1.0.0' }), kept: '^1.0.0' } },
    packages: optional ? [owner] : [owner, kept],
    parsedLayout: { hoistedLocations: { 'owner@1.0.0': ['node_modules/owner'], ...(optional ? {} : { 'kept@1.0.0': ['node_modules/kept'] }) } },
    parsedLock: {
      importers: { '.': { [field]: { kept: { specifier: '^1.0.0', version: '1.0.0' } } } },
      packages: { 'kept@1.0.0': { os: ['darwin'] } },
      snapshots: { 'owner@1.0.0': {}, 'kept@1.0.0': {} },
    },
  }
  const verifyRange = (version, requirement) => requirement === '^1.0.0' && version === '1.0.0'
  const run = () => dependencyRemovalScope(state, owner, name => state.packages.find(entry => entry.name === name) || null, { platform: 'win32', arch: 'x64' }, verifyRange)
  return { state, kept, run, field }
}

test('retained root requires matching declared specifier, importer version and installed snapshot', () => {
  assert.equal(fixture().run().complete, true)
  for (const mutate of [
    item => {
      item.state.parsedLock.importers['.'].dependencies.kept.version = '2.0.0'
    },
    item => {
      item.state.parsedLock.importers['.'].dependencies.kept.specifier = '^2.0.0'
    },
    item => {
      delete item.state.parsedLock.importers
    },
    item => {
      item.state.parsedLock.importers['.'].dependencies.kept.version = '1.0.0(peer@2)'
    },
    item => {
      item.state.manifest.dependencies.kept = '2.0.0'
      item.state.parsedLock.importers['.'].dependencies.kept.specifier = '2.0.0'
    },
  ]) {
    const item = fixture()
    mutate(item)
    assert.throws(item.run, /kept/)
  }
})

test('root optional platform exclusion requires exact lock proof and no actual inventory', () => {
  const item = fixture(true)
  const result = item.run()
  assert.equal(result.complete, true)
  assert.equal(result.platformEvidence.excluded[0].package, 'kept@1.0.0')
  assert.equal(result.platformEvidence.excluded[0].from, item.state.profile)
  for (const mutate of [
    value => {
      value.state.parsedLock.packages['kept@1.0.0'].os = ['win32']
    },
    value => {
      delete value.state.parsedLock.packages['kept@1.0.0']
    },
    value => {
      value.state.packages.push(value.kept)
    },
    value => {
      value.state.manifest.dependencies.kept = '^1.0.0'
    },
    value => {
      value.state.parsedLock.importers['.'].dependencies = { kept: { specifier: '^1.0.0', version: '1.0.0' } }
    },
  ]) {
    const changed = fixture(true)
    mutate(changed)
    assert.throws(changed.run)
  }
})

test('ordinary root cannot use platform exclusion, malformed declarations refuse', () => {
  const item = fixture()
  item.state.packages.pop()
  assert.throws(item.run, /kept/)
  item.state.manifest.dependencies = []
  assert.throws(item.run)
})

test('installed optional root needs its matching layout and version, not platform exclusion', () => {
  const item = fixture(true)
  item.state.packages.push(item.kept)
  item.state.parsedLayout.hoistedLocations['kept@1.0.0'] = ['node_modules/kept']
  assert.equal(item.run().complete, true)
  assert.equal(item.run().platformEvidence.excluded.length, 0)
  item.kept.version = '2.0.0'
  assert.throws(item.run, /kept/)
})

test('excluded optional root cannot conceal a reachable ordinary dependency', () => {
  const item = fixture(true)
  item.state.packages[0].manifest.dependencies = { kept: '1.0.0' }
  item.state.parsedLock.snapshots['owner@1.0.0'].dependencies = { kept: '1.0.0' }
  assert.throws(item.run, /kept/)
})

test('matching importer text cannot authorize a locked version outside the declared range', () => {
  for (const optional of [false, true]) {
    const item = fixture(optional)
    item.state.manifest[item.field].kept = '^2.0.0'
    item.state.parsedLock.importers['.'][item.field].kept.specifier = '^2.0.0'
    assert.throws(item.run, /kept/)
  }
})

test('missing range verifier refuses non-exact requirements', () => {
  const item = fixture()
  assert.throws(() => dependencyRemovalScope(item.state, item.state.packages[0], name => item.state.packages.find(entry => entry.name === name)), /kept/)
})
