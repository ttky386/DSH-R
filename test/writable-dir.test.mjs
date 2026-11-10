import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ensureWritableDir } from '../src/settings.js'

test('能写的目录：建出来、探针文件不留痕', async () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-dir-'))
  const target = join(base, 'versions')
  await ensureWritableDir(target)
  assert.ok(existsSync(target), '目录应该被建出来')
  assert.deepEqual(
    (await import('node:fs')).readdirSync(target),
    [],
    '探针文件应该被清掉，目录里什么都不留',
  )
})

test('已存在的目录同样要能写才算通过', async () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-dir-'))
  await ensureWritableDir(base) // 已存在：recursive mkdir 不会报错，靠探针兜住
})

test('指到一个文件上给出人话，而不是 EPERM/ENOTDIR 原文', async () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-dir-'))
  const file = join(base, 'not-a-dir.txt')
  writeFileSync(file, 'x')
  await assert.rejects(
    () => ensureWritableDir(file),
    (error) => {
      assert.match(error.message, /这不是一个目录/, '应该说清是文件不是目录')
      assert.doesNotMatch(error.message, /EPERM|ENOTDIR|EEXIST/, '不该把系统错误码原样丢给用户')
      return true
    },
  )
})
