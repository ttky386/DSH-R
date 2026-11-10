import { existsSync } from 'node:fs'
import { basename, dirname, join, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 平台常量，外加「Electron 本体当 node 用」的那套推导。
 *
 * 文件管理那一摊的行为（每用户目录在哪、外壳在哪、怎么弹对话框、怎么打开目录、
 * 开机自启）不在这里，在 filemanager.js 选出来的实现类里——这边只留常量，
 * 是为了让打包脚本能在任何一台机器上 import 它，不被平台判断牵连。
 */

const ROOT = dirname(fileURLToPath(import.meta.url))

export const IS_WINDOWS = process.platform === 'win32'
export const IS_MAC = process.platform === 'darwin'
export const IS_LINUX = process.platform === 'linux'

/** 管理服务是不是跑在 Electron 主进程里（三平台外壳都是，见 shell/main.mjs）。 */
export const IN_ELECTRON = Boolean(process.versions.electron)

/**
 * 打包后的核心：跑在用户目录的 core/current（安装包里不再带核心）。
 * 外壳（shell/main.mjs）加载核心前会设 DSH_CORE=1——核心不在 resources/app 里，
 * 但路径和更新行为都要按安装包处理。
 */
export const PACKAGED = (IN_ELECTRON && !process.defaultApp) || process.env.DSH_CORE === '1'

/** npm 版（dsh-x 包拉起 Electron）：更新走 npm，不走安装包/核心自更新。 */
export const NPM_MODE = process.env.DSH_NPM === '1'

/**
 * 拉子进程（dsh、npm、pnpm）用的 node。
 *
 * 普通情况下就是正在跑的这个 node（源码运行 = 系统 node）。Electron 外壳里没有单独的 node
 * 可执行文件：Electron 本体就带着 Node（Electron 44 是 24.21，满足 dsh 的 engines >=24.9），
 * 子进程设 ELECTRON_RUN_AS_NODE=1 后按 node 跑，所以这里固定把 Electron 本体当 node 返回。
 *
 * 安装包里的 node/ 只有 npm/pnpm 和命令行 shim（node.cmd 转调 Electron），**不发 node.exe**。
 * ≤0.1.19 的旧安装可能在 core 目录里留下 node.exe（v22.19，低于 dsh 的要求），就地升级后
 * 这份残留不能被优先使用：旧判断看的是 `join(root,'node','node.exe')`，一旦命中就会让
 * dsh 跑在过时的 Node 上（见 #89）。DSH_RUNTIME_NODE 仍可显式指定运行时（打包脚本/测试用）。
 */
export function runtimeNode(env = process.env, root = ROOT, inElectron = IN_ELECTRON, options = {}) {
  if (!inElectron) return process.execPath
  if (env.DSH_RUNTIME_NODE) return env.DSH_RUNTIME_NODE
  // Windows 打包态：安装器把 DSH.exe 硬链成 DSHNode.exe 专供 node 模式子进程。
  // 外壳与 dsh 实例从进程名上分开——安装器检测、任务管理器、单实例锁不再互相误伤
  //（曾经 dsh 子进程也叫 DSH.exe，外壳退出后残留一个就让安装器报“还在运行”）。
  const siblingNode = join(dirname(process.execPath), 'DSHNode.exe')
  if (IS_WINDOWS && (options.exists ? options.exists(siblingNode) : existsSync(siblingNode))) return siblingNode
  return process.execPath
}

/** 进程启动时定一次；server.js / registry.js / settings.js 都从这里取，别再各自读 process.execPath。 */
export const RUNTIME_NODE = runtimeNode()

/** RUNTIME_NODE 是不是 Electron 本体（Electron 自带 Node）。 */
export function runtimeNodeEnv(nodePath = RUNTIME_NODE, execPath = process.execPath, inElectron = IN_ELECTRON, isWindows = IS_WINDOWS) {
  if (!inElectron || !nodePath) return {}
  const left = isWindows ? String(nodePath).toLowerCase() : String(nodePath)
  const right = isWindows ? String(execPath).toLowerCase() : String(execPath)
  // DSHNode.exe 是 DSH.exe 的硬链接：路径不同、内容相同，不设 RUN_AS_NODE 会直接弹 GUI。
  const nameOf = isWindows ? win32.basename(String(nodePath)) : basename(String(nodePath))
  const siblingAsNode = isWindows && /^dshnode\.exe$/i.test(nameOf)
  return left === right || siblingAsNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}
}

/** 过滤掉 node_modules 里随包发的 node 之后的环境变量；spawn 子进程时展开它。 */
export const RUNTIME_NODE_ENV = runtimeNodeEnv()

/** 每用户目录的名字（settings.json、manager.log、webview 数据都在它下面；旧 Rust 外壳里有同名常量）。 */
export const APP_DIR_NAME = 'DSH'

/** macOS 包的名字和 bundle id：Info.plist、LaunchAgent、自更新都认它们。 */
export const MAC_APP_NAME = 'DSH-X.app'
export const MAC_BUNDLE_ID = 'io.github.yyh-001.dsh-x'
export const LINUX_BUNDLE_ID = 'io.github.yyh-001.dsh-x'
export const LINUX_ICON_NAME = 'dsh-x'
/** 外壳可执行文件名（Windows：安装器配置；macOS/Linux：electron-builder 的 executableName）。 */
export const LAUNCHER_NAME = 'DSH'
