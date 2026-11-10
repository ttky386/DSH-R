import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { isolateUserHome } from './isolated-home.mjs'

const folder = mkdtempSync(join(tmpdir(), 'dsh-settings-write-'))
isolateUserHome(folder)
const { saveSettings, loadSettings } = await import('../src/settings.js')
test.after(() => rmSync(folder, { recursive: true, force: true }))

test('并发保存不同字段保留各自结果，失败写入不阻塞后续请求', async () => {
  const results = await Promise.allSettled([
    saveSettings({ port: 999999 }),
    saveSettings({ theme: 'dark' }),
    saveSettings({ lang: 'en' }),
    saveSettings({ reduceMotion: true }),
  ])
  assert.equal(results[0].status, 'rejected')
  assert.ok(results.slice(1).every((result) => result.status === 'fulfilled'))
  const saved = await loadSettings()
  assert.equal(saved.theme, 'dark')
  assert.equal(saved.lang, 'en')
  assert.equal(saved.reduceMotion, true)
})

test('保存期间读取不会碰到半截 JSON 而回退默认设置', async () => {
  await saveSettings({ theme: 'dark' })
  const writes = Promise.allSettled(Array.from({ length: 20 }, (_, index) => saveSettings({ args: `--test=${index}` })))
  for (let index = 0; index < 50; index++) assert.equal((await loadSettings()).theme, 'dark')
  assert.ok((await writes).every((result) => result.status === 'fulfilled'))
  assert.equal((await loadSettings()).args, '--test=19')
})

test('跑 dsh 的 node：只认两档，路径去掉粘贴带上的引号', async () => {
  const saved = await saveSettings({ nodeRuntime: 'SYSTEM', systemNodePath: '  "C:\\Program Files\\nodejs\\node.exe"  ' })
  assert.equal(saved.nodeRuntime, 'system')
  assert.equal(saved.systemNodePath, 'C:\\Program Files\\nodejs\\node.exe')
  const dirty = await saveSettings({ nodeRuntime: 'weird', systemNodePath: '' })
  assert.equal(dirty.nodeRuntime, 'bundled')
  assert.equal(dirty.systemNodePath, '')
})

