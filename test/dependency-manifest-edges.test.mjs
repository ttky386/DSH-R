import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { dependencyRemovalScope } from '../src/repair-dependencies.js'

function fixture(manifest) {
  const profile = join(process.cwd(), 'memory-only-manifest')
  const owner = { name: 'owner', version: '1', dir: join(profile, 'node_modules/owner'), manifest }
  return {
    owner,
    state: {
      profile, manifest: { dependencies: { owner: '1' } }, packages: [owner],
      parsedLayout: { hoistedLocations: { 'owner@1': ['node_modules/owner'] } },
      parsedLock: { snapshots: { 'owner@1': {} } },
    },
  }
}

test('manifest dependency omitted from lock cannot certify a complete graph', () => {
  for (const field of ['dependencies', 'optionalDependencies']) {
    const item = fixture({ [field]: { 'missing-edge': '1' } })
    assert.throws(() => dependencyRemovalScope(item.state, item.owner, () => null), /missing-edge/)
  }
})

test('absent or malformed package manifest is missing evidence', () => {
  for (const manifest of [undefined, null, [], { dependencies: [] }, { optionalDependencies: 'missing' }]) {
    const item = fixture(manifest)
    assert.throws(() => dependencyRemovalScope(item.state, item.owner, () => null))
  }
})

test('unbound peer and development dependencies are not invented installation edges', () => {
  const item = fixture({ peerDependencies: { peer: '*' }, devDependencies: { development: '*' } })
  assert.equal(dependencyRemovalScope(item.state, item.owner, () => null).complete, true)
})

test('ordinary manifest edge cannot be downgraded to a platform optional edge', () => {
  const item = fixture({ dependencies: { native: '1' } })
  item.state.parsedLock.snapshots['owner@1'].optionalDependencies = { native: '1' }
  item.state.parsedLock.snapshots['native@1'] = {}
  item.state.parsedLock.packages = { 'native@1': { os: ['darwin'] } }
  assert.throws(() => dependencyRemovalScope(item.state, item.owner, () => null, { platform: 'win32', arch: 'x64' }))
})
