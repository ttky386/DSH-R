import test from 'node:test'
import assert from 'node:assert/strict'
import { join, relative } from 'node:path'
import { dependencyRemovalScope } from '../src/repair-dependencies.js'
import { createHash } from 'node:crypto'

function fixture() {
  const profile = join(process.cwd(), 'memory-profile')
  const owner = { manifest: { optionalDependencies: { 'other-platform': '1.0.0' } }, name: 'owner', version: '1.0.0', dir: join(profile, 'node_modules/owner') }
  const state = {
    profile,
    manifest: { dependencies: { owner: '1.0.0' } },
    packages: [owner],
    parsedLayout: { hoistedLocations: { 'owner@1.0.0': [relative(profile, owner.dir).replaceAll('\\', '/')] }, skipped: ['other-platform@1.0.0'] },
    parsedLock: {
      packages: { 'other-platform@1.0.0': { os: ['darwin'], cpu: ['arm64'] } },
      snapshots: { 'owner@1.0.0': { optionalDependencies: { 'other-platform': '1.0.0' } }, 'other-platform@1.0.0': {} },
    },
  }
  const target = { platform: 'win32', arch: 'x64' }
  const resolvePackage = name => state.packages.find(item => item.name === name) || null
  return { state, owner, target, resolvePackage }
}

test('exact optional platform exclusion is evidence, skipped alone is not the decision', () => {
  const item = fixture()
  delete item.state.parsedLayout.skipped
  const result = dependencyRemovalScope(item.state, item.owner, item.resolvePackage, item.target)
  assert.equal(result.complete, true)
  assert.deepEqual(result.predicted.map(row => row.name), ['owner'])
  assert.equal(result.platformEvidence.excluded.length, 1)
  assert.equal(result.platformEvidence.excluded[0].package, 'other-platform@1.0.0')
  assert.equal(result.platformEvidence.excluded[0].skipped, false)
  assert.deepEqual(result.platformEvidence.target, item.target)
})

test('applicable, unknown, ambiguous or unsupported constraints never excuse missing packages', () => {
  for (const metadata of [undefined, {}, { os: ['win32'] }, { os: 'darwin' }, { os: [] }, { os: ['mystery'] }, { os: ['darwin'], libc: ['unknown'] }, { cpu: ['unknown'] }]) {
    const item = fixture()
    item.state.parsedLock.packages['other-platform@1.0.0'] = metadata
    assert.throws(() => dependencyRemovalScope(item.state, item.owner, item.resolvePackage, item.target))
  }
  const item = fixture()
  assert.throws(() => dependencyRemovalScope(item.state, item.owner, item.resolvePackage, { platform: 'mystery', arch: 'x64' }))
})

test('OS exclusion remains conclusive with known libc constraints, but libc alone cannot exclude', () => {
  const item = fixture()
  item.state.parsedLock.packages['other-platform@1.0.0'] = { os: ['linux'], cpu: ['x64'], libc: ['musl'] }
  const result = dependencyRemovalScope(item.state, item.owner, item.resolvePackage, item.target)
  assert.deepEqual(result.platformEvidence.excluded[0].libc, ['musl'])
  assert.deepEqual(result.platformEvidence.excluded[0].evaluated, ['os', 'cpu'])
  assert.throws(() => dependencyRemovalScope(item.state, item.owner, item.resolvePackage, { platform: 'linux', arch: 'x64' }))
  item.state.parsedLock.packages['other-platform@1.0.0'].libc = 'musl'
  assert.throws(() => dependencyRemovalScope(item.state, item.owner, item.resolvePackage, item.target))
})

test('a mandatory reachable edge to the same package refuses optional exclusion', () => {
  const item = fixture()
  item.state.parsedLock.snapshots['owner@1.0.0'].dependencies = { 'other-platform': '1.0.0' }
  assert.throws(() => dependencyRemovalScope(item.state, item.owner, item.resolvePackage, item.target))
})

test('a wrong actual version or unexplained unresolved inventory is never platform-excluded', () => {
  const item = fixture()
  assert.throws(() => dependencyRemovalScope(item.state, item.owner, () => ({ name: 'other-platform', version: '2.0.0', dir: '/elsewhere' }), item.target))
  item.state.packages.push({ name: 'other-platform', version: '1.0.0', dir: join(item.state.profile, 'node_modules/other-platform') })
  assert.throws(() => dependencyRemovalScope(item.state, item.owner, () => null, item.target))
})

test('negated platform selectors have explicit semantics and target changes affect evidence', () => {
  const item = fixture()
  item.state.parsedLock.packages['other-platform@1.0.0'] = { os: ['!win32'] }
  const result = dependencyRemovalScope(item.state, item.owner, item.resolvePackage, item.target)
  assert.equal(result.platformEvidence.excluded.length, 1)
  assert.throws(() => dependencyRemovalScope(item.state, item.owner, item.resolvePackage, { platform: 'linux', arch: 'x64' }))
})

test('a mandatory edge from another installed root remains blocking', () => {
  const item = fixture()
  const other = { manifest: { dependencies: { 'other-platform': '1.0.0' } }, name: 'other-root', version: '1.0.0', dir: join(item.state.profile, 'node_modules/other-root') }
  item.state.packages.push(other)
  item.state.manifest.dependencies[other.name] = other.version
  item.state.parsedLock.importers = { '.': { dependencies: { [other.name]: { specifier: other.version, version: other.version } } } }
  item.state.parsedLayout.hoistedLocations['other-root@1.0.0'] = [relative(item.state.profile, other.dir).replaceAll('\\', '/')]
  item.state.parsedLock.snapshots['other-root@1.0.0'] = { dependencies: { 'other-platform': '1.0.0' } }
  assert.throws(() => dependencyRemovalScope(item.state, item.owner, item.resolvePackage, item.target))
})

test('unknown CPU evidence cannot be ignored even if OS would exclude', () => {
  const item = fixture()
  item.state.parsedLock.packages['other-platform@1.0.0'].cpu = 'arm64'
  assert.throws(() => dependencyRemovalScope(item.state, item.owner, item.resolvePackage, item.target))
})

test('platform proof digest changes with target, constraints and skipped evidence', () => {
  const item = fixture()
  function digest() {
    return createHash('sha256').update(JSON.stringify(dependencyRemovalScope(item.state, item.owner, item.resolvePackage, item.target).platformEvidence)).digest('hex')
  }
  const original = digest()
  item.target.arch = 'arm64'
  assert.notEqual(digest(), original)
  item.target.arch = 'x64'
  item.state.parsedLock.packages['other-platform@1.0.0'].os = ['linux']
  assert.notEqual(digest(), original)
  item.state.parsedLock.packages['other-platform@1.0.0'].os = ['darwin']
  item.state.parsedLayout.skipped = []
  assert.notEqual(digest(), original)
})
