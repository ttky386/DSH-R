/**
 * 桌面端系统开关的两端约定：settings.js 写 / 校验，shell/prefs.mjs 读。两边默认值必须一致，
 * 否则「没写过这个键」在页面上和外壳里会是两个意思。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { isolateUserHome } from './isolated-home.mjs'
import { PREF_DEFAULTS } from '../shell/prefs.mjs'

const folder = mkdtempSync(join(tmpdir(), 'dsh-system-prefs-'))
isolateUserHome(folder)
const { saveSettings, loadSettings, DEFAULTS } = await import('../src/settings.js')
test.after(() => rmSync(folder, { recursive: true, force: true }))

const KEYS = Object.keys(PREF_DEFAULTS)

test('默认值两端一致（settings.js 的 DEFAULTS 与 shell/prefs.mjs 的 PREF_DEFAULTS）', () => {
  for (const key of KEYS) {
    assert.equal(DEFAULTS[key], PREF_DEFAULTS[key], `${key} 的默认值在两边不一样`)
  }
})

test('七个开关能存能读，保存后的值原样回来', async () => {
  const patch = {
    hardwareAcceleration: false,
    autoUpdate: true,
    taskNotifications: false,
    notificationSound: false,
    closeToTray: false,
    keepAwake: true,
    browserIgnoreCertificate: true,
  }
  const saved = await saveSettings(patch)
  for (const [key, value] of Object.entries(patch)) assert.equal(saved[key], value)
  const loaded = await loadSettings()
  for (const [key, value] of Object.entries(patch)) assert.equal(loaded[key], value)
})

test('脏值回默认：true 型只认 true，false 型只认 false', async () => {
  const saved = await saveSettings({
    hardwareAcceleration: 'no',
    autoUpdate: 'true',
    taskNotifications: 0,
    notificationSound: 'false',
    closeToTray: null,
    keepAwake: {},
    browserIgnoreCertificate: 'yes',
  })
  assert.equal(saved.hardwareAcceleration, true)
  assert.equal(saved.autoUpdate, false)
  assert.equal(saved.taskNotifications, true)
  assert.equal(saved.notificationSound, true)
  assert.equal(saved.closeToTray, true)
  assert.equal(saved.keepAwake, false)
  // 忽略证书默认关（脏值当关）
  assert.equal(saved.browserIgnoreCertificate, false)
})
