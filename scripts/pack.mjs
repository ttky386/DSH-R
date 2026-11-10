// Windows/macOS/Linux 打包：electron-builder 出安装包（NSIS / dmg / AppImage），
// 外壳自更新交给 electron-updater。
//
// 安装包里只有外壳（release/shell-stage → resources/app）：Electron main/tray/updater/preload/tabs
// + electron-updater 依赖。二开安装包内置 dsh-r-core 离线引导包，
// 所以外壳可以很久不发版、核心照发。
//
// 核心层（release/core-stage）只在打 npm 核心包时才组装，见 --stage-only：
//   node scripts/pack.mjs --stage-only && node scripts/pack-core.mjs
//
// electron-builder 直接打包 shell-stage。

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { chmod, cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  NODE_VERSION,
  PKG,
  ROOT,
  VENDOR,
  copyAppFiles,
  copyNpmModules,
  copyPnpm as copyPnpmModule,
  downloadNodeFile,
  run,
} from './pack-common.mjs'

const HOST_IS_LINUX = process.platform === 'linux'
const HOST_IS_WINDOWS = process.platform === 'win32'
// 允许在 Linux 上交叉打 Windows 包：核心层是跨平台 JS，Electron/NSIS 由 electron-builder 处理。
const TARGET_PLATFORM_TEXT = String(process.env.DSH_TARGET_PLATFORM || process.platform).trim().toLowerCase()
const IS_MAC = TARGET_PLATFORM_TEXT === 'darwin' || TARGET_PLATFORM_TEXT === 'mac'
const IS_LINUX = TARGET_PLATFORM_TEXT === 'linux'
const IS_WINDOWS = TARGET_PLATFORM_TEXT === 'win' || TARGET_PLATFORM_TEXT === 'win32'
const PLATFORM = IS_MAC ? 'darwin' : IS_LINUX ? 'linux' : 'win'
const ARCH = process.arch === 'arm64' ? 'arm64' : 'x64'
const ARCHIVE_EXT = IS_MAC ? 'tar.gz' : IS_LINUX ? 'tar.xz' : 'zip'
const DIST = `node-v${NODE_VERSION}-${PLATFORM}-${ARCH}`
const ARCHIVE = `${DIST}.${ARCHIVE_EXT}`
const EXTRACTED = join(VENDOR, DIST)
const SHELL_STAGE = join(ROOT, 'release', 'shell-stage')
const CORE_STAGE = join(ROOT, 'release', 'core-stage')
const CORE_BOOTSTRAP = join(ROOT, 'release', 'core-bootstrap')
const SHELL_DIR = join(ROOT, 'shell')
const ELECTRON_BUILDER = join(ROOT, 'node_modules', 'electron-builder', 'cli.js')
const SHELL_PKG = JSON.parse(readFileSync(join(SHELL_DIR, 'package.json'), 'utf8'))
const ELECTRON_VERSION = JSON.parse(readFileSync(join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8')).version

async function ensureNode() {
  await mkdir(VENDOR, { recursive: true })
  if (existsSync(join(EXTRACTED, IS_MAC || IS_LINUX ? 'bin/node' : 'node.exe'))) return
  const archive = join(VENDOR, ARCHIVE)
  await downloadNodeFile(ARCHIVE, archive)
  if (IS_MAC || IS_LINUX) run('tar', [IS_LINUX ? '-xJf' : '-xzf', archive, '-C', VENDOR])
  else if (HOST_IS_LINUX && IS_WINDOWS) run('unzip', ['-q', '-o', archive, '-d', VENDOR])
  else run('powershell', ['-NoProfile', '-Command', `Expand-Archive -Force '${archive}' '${VENDOR}'`])
}

/**
 * 核心的 node/ 目录：只有 npm/pnpm 的 JS 和包装脚本；node 本体由 Electron/外壳提供。
 * 核心包跨平台，所以两套包装都写：Windows 用 node.cmd / pnpm.cmd，POSIX 用 sh 脚本；
 * 同一个目录在三个平台都能用，PATH 按平台挑到对应的那个。
 */
async function copyNodeRuntime(nodeDir) {
  await mkdir(nodeDir, { recursive: true })
  const modules = join(EXTRACTED, IS_WINDOWS ? '' : 'lib', 'node_modules')
  await copyNpmModules(modules, nodeDir)
  await copyPnpmModule(nodeDir, join(modules, 'npm', 'bin', 'npm-cli.js'))

  // POSIX：DSH_ELECTRON_BIN 由外壳/CLI 设置；没有时依次试安装版的 Windows / mac / Linux 布局
  const nodeShim = join(nodeDir, 'node')
  await writeFile(nodeShim, [
    '#!/bin/sh',
    'if [ -n "$DSH_ELECTRON_BIN" ]; then ELECTRON_RUN_AS_NODE=1 exec "$DSH_ELECTRON_BIN" "$@"; fi',
    'dir="$(cd "$(dirname "$0")" && pwd)"',
    'if [ -x "$dir/../../../DSH.exe" ]; then ELECTRON_RUN_AS_NODE=1 exec "$dir/../../../DSH.exe" "$@"; fi',
    'if [ -x "$dir/../../../MacOS/DSH" ]; then ELECTRON_RUN_AS_NODE=1 exec "$dir/../../../MacOS/DSH" "$@"; fi',
    'ELECTRON_RUN_AS_NODE=1 exec "$dir/../../../DSH" "$@"',
    '',
  ].join('\n'))
  await chmod(nodeShim, 0o755)
  const shims = { npm: 'npm/bin/npm-cli.js', npx: 'npm/bin/npx-cli.js', pnpm: 'pnpm/bin/pnpm.cjs', pnpx: 'pnpm/bin/pnpx.cjs' }
  for (const [name, cli] of Object.entries(shims)) {
    const file = join(nodeDir, name)
    await writeFile(file, [
      '#!/bin/sh',
      'dir="$(cd "$(dirname "$0")" && pwd)"',
      `exec "$dir/node" "$dir/node_modules/${cli}" "$@"`,
      '',
    ].join('\n'))
    await chmod(file, 0o755)
  }

  // Windows
  await writeFile(join(nodeDir, 'node.cmd'), [
    '@ECHO off',
    'SETLOCAL',
    'SET "ELECTRON_RUN_AS_NODE=1"',
    'IF DEFINED DSH_ELECTRON_BIN (',
    '  "%DSH_ELECTRON_BIN%" %*',
    ') ELSE (',
    '  "%~dp0..\\..\\..\\DSH.exe" %*',
    ')',
    '',
  ].join('\r\n'))
  await writeFile(join(nodeDir, 'pnpm.cmd'), [
    '@ECHO off',
    'SETLOCAL',
    'SET "PNPM_JS=%~dp0node_modules\\pnpm\\bin\\pnpm.cjs"',
    'call "%~dp0node.cmd" "%PNPM_JS%" %*',
    '',
  ].join('\r\n'))
  await writeFile(join(nodeDir, 'pnpx.cmd'), [
    '@ECHO off',
    'SETLOCAL',
    'call "%~dp0node.cmd" "%~dp0node_modules\\pnpm\\bin\\pnpx.cjs" %*',
    '',
  ].join('\r\n'))
}

/** 核心层：npm 核心包的来源（安装包里已经不再带它）。 */
async function buildCoreStage() {
  await rm(CORE_STAGE, { recursive: true, force: true })
  await mkdir(CORE_STAGE, { recursive: true })
  await copyAppFiles(CORE_STAGE)
  await copyNodeRuntime(join(CORE_STAGE, 'node'))
  await writeFile(join(CORE_STAGE, 'package.json'), `${JSON.stringify({
    // 核心包跨平台：同一个 dsh-r-core 在 Windows / mac / Linux 上都能用，只有外壳按平台分开
    name: 'dsh-r-core',
    productName: 'DSH',
    version: PKG.version,
    private: true,
    type: 'module',
    main: 'server.js',
    // 核心按哪个 Electron 版本构建；外壳发现不一致就让用户更新外壳
    dshX: { electron: ELECTRON_VERSION },
  }, null, 2)}\n`)
  console.log(`核心层：${CORE_STAGE}（${PKG.version}）`)
}

/** 生成随安装包内置的离线核心引导包；外壳用 core.json 校验包名、版本和 Electron。 */
async function buildCoreBootstrap() {
  await rm(CORE_BOOTSTRAP, { recursive: true, force: true })
  await mkdir(CORE_BOOTSTRAP, { recursive: true })
  await buildCoreStage()
  run(process.execPath, [join(ROOT, 'scripts', 'pack-core.mjs'), '--out', CORE_BOOTSTRAP])
  const packed = (await readdir(CORE_BOOTSTRAP)).find((name) => name.endsWith('.tgz'))
  if (!packed) throw new Error('打包二开核心引导包失败')
  await cp(join(CORE_BOOTSTRAP, packed), join(CORE_BOOTSTRAP, 'core.tgz'))
  await rm(join(CORE_BOOTSTRAP, packed), { force: true })
  await writeFile(join(CORE_BOOTSTRAP, 'core.json'), `${JSON.stringify({
    name: 'dsh-r-core',
    version: PKG.version,
    electron: ELECTRON_VERSION,
  }, null, 2)}\n`)
  console.log(`内置核心引导包：${CORE_BOOTSTRAP}（${PKG.version}）`)
}

/** 外壳：安装包的 resources/app；版本来自 shell/package.json，和核心版本分开。 */
async function buildShellStage() {
  await rm(SHELL_STAGE, { recursive: true, force: true })
  await mkdir(SHELL_STAGE, { recursive: true })
  await cp(SHELL_DIR, join(SHELL_STAGE, 'shell'), { recursive: true })
  // 托盘 / 窗口图标（shell/main.mjs 的 ICON_FILE 指向 app 根目录的 assets）
  await cp(join(ROOT, 'src', 'assets'), join(SHELL_STAGE, 'assets'), { recursive: true })
  await writeFile(join(SHELL_STAGE, 'package.json'), `${JSON.stringify({
    // 这个 name 就是 deb 的包名——electron-builder 读的是 app 目录这份 package.json，
    // 不是仓库根那个，所以 apt remove 后面的名字由这里决定。
    name: 'dsh-x',
    productName: 'DSH-X',
    version: SHELL_PKG.version,
    private: true,
    type: 'module',
    description: 'DSH-X desktop shell',
    author: 'yyh',
    desktopName: 'DSH-X',
    license: 'MIT',
    main: 'shell/main.mjs',
    dependencies: { 'electron-updater': '^6.8.11' },
  }, null, 2)}\n`)
  // 外壳自更新依赖装进 app 层。Windows 下不能走 npm.cmd：cmd.exe 不支持 UNC 当前目录，
  // 从 WSL 路径打包会掉到 C:\Windows 并尝试写 package-lock；这里直接用当前 Node 的 npm-cli。
  const windowsNpmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  const npmCommand = process.platform === 'win32' && existsSync(windowsNpmCli) ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const npmArgs = process.platform === 'win32' && existsSync(windowsNpmCli) ? [windowsNpmCli, 'install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'] : ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund']
  const npm = spawnSync(npmCommand, npmArgs, { cwd: SHELL_STAGE, stdio: 'inherit', windowsHide: false, shell: process.platform === 'win32' && npmCommand === 'npm.cmd' })
  if (npm.status !== 0) throw new Error('npm install (shell stage) failed')
  console.log(`外壳层：${SHELL_STAGE}（${SHELL_PKG.version}）`)
}

function buildInstaller() {
  if (!existsSync(ELECTRON_BUILDER)) throw new Error('缺少 electron-builder，先 npm install')
  const args = [ELECTRON_BUILDER, '--config', join(ROOT, 'electron-builder.config.mjs'), '--publish', 'never']
  if (IS_MAC) args.push('--mac', process.arch === 'arm64' ? '--arm64' : '--x64')
  else if (IS_LINUX) args.push('--linux', process.arch === 'arm64' ? '--arm64' : '--x64')
  else args.push('--win')
  run(process.execPath, args)
  console.log(`安装包输出：${join(ROOT, 'release', 'eb')}`)
}

if (process.argv.includes('--stage-only')) {
  await ensureNode()
  await buildCoreStage()
  console.log('--stage-only：只组装核心层，不出安装包')
} else {
  await ensureNode()
  await buildCoreBootstrap()
  await buildShellStage()
  buildInstaller()
}
