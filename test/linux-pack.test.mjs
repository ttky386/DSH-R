import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const read = (path) => readFileSync(join(ROOT, path), 'utf8')

test('Linux 外壳走 AppImage + deb，并内置二开离线核心', () => {
  const config = read('electron-builder.config.mjs')
  assert.match(config, /target: 'AppImage', arch: \['x64'\]/)
  assert.match(config, /target: 'deb', arch: \['x64'\]/)
  assert.match(config, /from: 'release\/core-bootstrap', to: 'core-bootstrap'/)
  assert.match(config, /dsh-r-core/)
  assert.match(read('shell/main.mjs'), /core-fetch\.mjs/)
  assert.match(config, /StartupWMClass: 'DSH-X'/)

  const pack = read('scripts/pack.mjs')
  assert.match(pack, /--stage-only/)
  assert.match(pack, /buildCoreBootstrap\(\)/)
  assert.match(pack, /name: 'dsh-r-core'/)
  assert.match(pack, /args\.push\('--linux', process\.arch === 'arm64' \? '--arm64' : '--x64'\)/)
})

test('Windows 宿主机从 WSL UNC 路径打包时不经 npm.cmd 改写当前目录', () => {
  const pack = read('scripts/pack.mjs')
  assert.match(pack, /const windowsNpmCli = join\(dirname\(process\.execPath\), 'node_modules', 'npm', 'bin', 'npm-cli\.js'\)/)
  assert.match(pack, /npmCommand = process\.platform === 'win32' && existsSync\(windowsNpmCli\) \? process\.execPath/)
  // npm.cmd 会把 UNC cwd 掉到 C:\Windows；直调 npm-cli.js 时必须关闭 shell。
  assert.doesNotMatch(pack.slice(pack.indexOf('const windowsNpmCli'), pack.indexOf('const npm = spawnSync')), /shell: true/)
})

test('Linux 外壳和核心都遵循 XDG 配置目录', () => {
  assert.match(read('shell/main.mjs'), /XDG_CONFIG_HOME/)
  assert.match(read('shell/main.mjs'), /join\(homedir\(\), '\.config'\)/)
  assert.match(read('src/filemanager-linux.js'), /XDG_CONFIG_HOME/)
  assert.match(read('src/server.js'), /!IS_WINDOWS && !IS_MAC && !IS_LINUX/, 'Linux 也使用跨平台 npm 核心更新')
})
