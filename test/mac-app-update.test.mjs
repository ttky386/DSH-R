import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { MAC_APP_SWAP_SCRIPT, macSignatureAllowsIncremental } from '../src/server.js'

const POSIX = process.platform !== 'win32'
const tempRoot = () => mkdtempSync(join(realpathSync.native(tmpdir()), 'dsh-mac-apply-'))

test('mac 签名状态决定能不能走增量：ad-hoc/未签名可以，固定证书走完整包', () => {
  assert.deepEqual(macSignatureAllowsIncremental('Executable=DSH\nSignature=adhoc\nIdentifier=io.github.yyh-001.dsh-x'), { ok: true, identity: '-' })
  assert.deepEqual(macSignatureAllowsIncremental('code object is not signed at all\nIn subcomponent: /x.app'), { ok: true, identity: '-' })
  const developer = macSignatureAllowsIncremental('Authority=Developer ID Application: Someone (TEAMID)\nAuthority=Developer ID Certification Authority')
  assert.equal(developer.ok, false)
  assert.equal(developer.reason, 'signed')
  assert.equal(macSignatureAllowsIncremental('').ok, false)
})

test('替换脚本的 sh 语法正确', { skip: !POSIX && 'Windows 上没有 /bin/sh' }, () => {
  const root = tempRoot()
  try {
    const file = join(root, 'swap.sh')
    writeFileSync(file, MAC_APP_SWAP_SCRIPT)
    const result = spawnSync('sh', ['-n', file], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/** 造一套假的包目录 + 命令桩；open 桩按 createMarker 决定要不要写启动标记。 */
function harness({ codesignFailsOnce = false, createMarker = true } = {}) {
  const root = tempRoot()
  const bundle = join(root, 'DSH-X.app')
  const appDir = join(bundle, 'Contents', 'Resources', 'app')
  const staged = join(root, 'staged')
  const bin = join(root, 'bin')
  const marker = join(root, 'update-ok')
  const logFile = join(root, 'update.log')
  const backup = join(root, 'app.bak')
  const stubLog = join(root, 'stub.log')
  const counter = join(root, 'codesign-count')
  mkdirSync(appDir, { recursive: true })
  mkdirSync(staged, { recursive: true })
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(appDir, 'old.txt'), 'old\n')
  writeFileSync(join(staged, 'new.txt'), 'new\n')
  writeFileSync(marker, 'stale\n')
  const stub = (name, body) => {
    const file = join(bin, name)
    writeFileSync(file, `#!/bin/sh\n${body}\n`)
    chmodSync(file, 0o755)
  }
  stub('codesign', codesignFailsOnce
    ? `n=$(cat "${counter}" 2>/dev/null || echo 0); echo $((n + 1)) >"${counter}"; echo "codesign $@" >>"${stubLog}"; [ "$n" = "0" ] && exit 1; exit 0`
    : `echo "codesign $@" >>"${stubLog}"; exit 0`)
  stub('open', `echo "open $@" >>"${stubLog}"; ${createMarker ? `touch "${marker}"` : ':'}; exit 0`)
  stub('xattr', `echo "xattr $@" >>"${stubLog}"; exit 0`)
  stub('pkill', `echo "pkill $@" >>"${stubLog}"; exit 0`)
  const script = join(root, 'swap.sh')
  writeFileSync(script, MAC_APP_SWAP_SCRIPT)
  const result = spawnSync('sh', [script, '999999', appDir, staged, bundle, logFile, marker, backup, '-'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  })
  return { root, appDir, bundle, marker, logFile, backup, stubLog, result }
}

test('换包成功：备份旧目录、换入新目录、重签、清隔离属性、等标记后清备份', { skip: !POSIX && '替换助手是 /bin/sh 脚本' }, () => {
  const h = harness()
  try {
    assert.equal(h.result.status, 0, `${h.result.stderr}\n${existsSync(h.logFile) ? readFileSync(h.logFile, 'utf8') : ''}`)
    assert.equal(readFileSync(join(h.appDir, 'new.txt'), 'utf8'), 'new\n')
    assert.ok(!existsSync(join(h.appDir, 'old.txt')))
    assert.ok(!existsSync(h.backup), '启动成功后应清掉备份')
    const stubs = readFileSync(h.stubLog, 'utf8')
    assert.match(stubs, /codesign --force --deep --sign - /)
    assert.match(stubs, /xattr -dr com\.apple\.quarantine /)
    assert.match(readFileSync(h.logFile, 'utf8'), /新版本启动成功/)
  } finally {
    rmSync(h.root, { recursive: true, force: true })
  }
})

test('重签失败：换回旧目录、重签旧包、重开旧版', { skip: !POSIX && '替换助手是 /bin/sh 脚本' }, () => {
  const h = harness({ codesignFailsOnce: true, createMarker: false })
  try {
    assert.notEqual(h.result.status, 0)
    assert.equal(readFileSync(join(h.appDir, 'old.txt'), 'utf8'), 'old\n')
    assert.ok(!existsSync(join(h.appDir, 'new.txt')))
    assert.ok(!existsSync(h.backup), '回滚后备份应已挪回原位')
    assert.equal(readFileSync(h.stubLog, 'utf8').match(/^open /gm).length, 1, '回滚后应重新打开旧版')
    assert.match(readFileSync(h.logFile, 'utf8'), /重新签名失败，回滚/)
  } finally {
    rmSync(h.root, { recursive: true, force: true })
  }
})
