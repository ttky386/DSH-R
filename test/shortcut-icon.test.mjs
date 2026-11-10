import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { refreshShortcuts } from '../src/server.js'

const WINDOWS = process.platform === 'win32'

function powershell(script) {
  return execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' }).trim()
}

function createShortcut(link, target) {
  const quote = (value) => `'${String(value).replace(/'/g, "''")}'`
  powershell(`$s=(New-Object -ComObject WScript.Shell).CreateShortcut(${quote(link)}); $s.TargetPath=${quote(target)}; $s.IconLocation=${quote(`${target},0`)}; $s.Save()`)
}

function readIcon(link) {
  const quote = (value) => `'${String(value).replace(/'/g, "''")}'`
  return powershell(`$s=(New-Object -ComObject WScript.Shell).CreateShortcut(${quote(link)}); $s.IconLocation`)
}

test('刷新快捷方式图标：拷当前版本图标、改 .lnk、清旧图标、记戳', { skip: !WINDOWS && '只在 Windows 上验证 .lnk' }, async () => {
  // 目录名带单引号，顺带验证 PowerShell 转义
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), "dsh-icon-o'brien-"))
  const installRoot = join(root, 'DSH')
  const appDir = join(installRoot, 'app', '0.1.21')
  const assets = join(installRoot, 'assets')
  mkdirSync(appDir, { recursive: true })
  mkdirSync(assets, { recursive: true })
  writeFileSync(join(assets, 'dsh-0.1.20.ico'), 'old icon')
  const link = join(root, 'DSH-X.lnk')
  createShortcut(link, process.execPath)
  const iconTarget = join(assets, 'dsh-0.1.21.ico')
  try {
    const changed = await refreshShortcuts({ installRoot, appDir, version: '0.1.21', links: [link], force: true })
    assert.equal(changed, true)
    assert.ok(existsSync(iconTarget), '当前版本图标应写进安装根目录')
    assert.equal(readIcon(link), `${iconTarget},0`)
    assert.equal(readFileSync(join(appDir, 'shortcut-icon'), 'utf8'), '0.1.21')
    assert.ok(!existsSync(join(assets, 'dsh-0.1.20.ico')), '旧版本图标应清掉')

    // 同一版本再跑：直接跳过，不重做
    rmSync(iconTarget)
    const again = await refreshShortcuts({ installRoot, appDir, version: '0.1.21', links: [link], force: true })
    assert.equal(again, false)
    assert.ok(!existsSync(iconTarget), '记过戳就不该再拷图标')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

