import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { CORE_PACKAGE, coreDistTag, coreMetadataUrl, extractCoreTarball, resolveCoreRelease, stagingStats, tarCommand } from '../src/core-npm.js'
import { VERSION_CHANNEL } from '../src/version.js'

const tempRoot = () => mkdtempSync(join(realpathSync.native(tmpdir()), 'dsh-core-npm-'))

test('npm 元数据：按通道取 dist-tag，取不到退回 latest', () => {
  const release = (version, extra = {}) => ({ version, dist: { tarball: `https://example.com/${version}.tgz`, integrity: `sha512-${version}`, shasum: 'abc', unpackedSize: 123 }, dshX: { electron: '44.7.0' }, ...extra })
  const metadata = {
    'dist-tags': { latest: '0.1.20', rc: '0.1.21-rc.1', alpha: '0.1.22-alpha.1' },
    versions: {
      '0.1.20': release('0.1.20'),
      '0.1.21-rc.1': release('0.1.21-rc.1'),
      '0.1.22-alpha.1': release('0.1.22-alpha.1'),
    },
  }
  assert.equal(coreDistTag(VERSION_CHANNEL.OFFICIAL), 'latest')
  assert.equal(coreDistTag(VERSION_CHANNEL.RC), 'rc')
  assert.equal(coreDistTag(VERSION_CHANNEL.ALPHA), 'alpha')
  assert.equal(resolveCoreRelease(metadata, VERSION_CHANNEL.OFFICIAL).version, '0.1.20')
  assert.equal(resolveCoreRelease(metadata, VERSION_CHANNEL.RC).version, '0.1.21-rc.1')
  assert.equal(resolveCoreRelease(metadata, VERSION_CHANNEL.ALPHA).version, '0.1.22-alpha.1')
  const alpha = resolveCoreRelease(metadata, VERSION_CHANNEL.ALPHA)
  assert.equal(alpha.electron, '44.7.0')
  assert.equal(alpha.tarball, 'https://example.com/0.1.22-alpha.1.tgz')
  assert.equal(resolveCoreRelease({ 'dist-tags': { next: '1.0.0' }, versions: {} }, VERSION_CHANNEL.RC), null)
  assert.equal(resolveCoreRelease({ 'dist-tags': { latest: '1.0.0' }, versions: {} }, VERSION_CHANNEL.OFFICIAL), null)
})

test('npm 包名：核心包跨平台，scoped 包要编码斜杠', () => {
  assert.equal(CORE_PACKAGE, 'dsh-x-remote-core', '二开核心与上游包名隔离')
  assert.equal(coreMetadataUrl('https://registry.npmjs.org/', 'dsh-x-core'), 'https://registry.npmjs.org/dsh-x-core')
  assert.equal(coreMetadataUrl('https://registry.npmjs.org', '@scope/dsh-x-core'), 'https://registry.npmjs.org/@scope%2Fdsh-x-core')
})

test('解压 npm tarball：剥掉 package/ 前缀，校验 server.js 和 package.json', { skip: spawnSync(tarCommand(), ['--version']).error ? '没有 tar' : false }, () => {
  const root = tempRoot()
  try {
    const source = join(root, 'package')
    mkdirSync(source, { recursive: true })
    writeFileSync(join(source, 'server.js'), 'console.log(1)\n')
    writeFileSync(join(source, 'package.json'), JSON.stringify({ version: '9.9.9' }))
    const tarball = join(root, 'core.tgz')
    const packed = spawnSync(tarCommand(), ['-czf', tarball, '-C', root, 'package'], { encoding: 'utf8' })
    assert.equal(packed.status, 0, packed.stderr)
    const dest = join(root, 'out')
    const pkg = extractCoreTarball(tarball, dest)
    assert.equal(pkg.version, '9.9.9')
    assert.equal(stagingStats(dest).files, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
