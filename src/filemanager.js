import { IS_LINUX, IS_MAC, IS_WINDOWS } from './platform.js'
import { FileManager, PosixFileManager } from './filemanager-base.js'

/**
 * 按平台挑一套文件管理实现，业务代码只认这里导出的 `fileManager`。
 *
 * 三套实现都随核心包发（核心 npm 包是跨平台的，见 scripts/pack-common.mjs 的
 * FILE_MANAGERS）；运行时用动态 import 只加载当前平台那一套。这样同一个 dsh-x-remote-core
 * 在 Windows、macOS 和 Linux 上都能用，只有外壳/Electron 按平台分开。
 *
 * 契约、基类和其它类 Unix 系统的兜底实现都在 filemanager-base.js：实现类静态
 * import 的是它，不是本文件——本文件有顶层 await，实现类再回头 import 它就会死锁。
 */
async function pickFileManager() {
  if (IS_WINDOWS) return (await import('./filemanager-windows.js')).WindowsFileManager
  if (IS_MAC) return (await import('./filemanager-mac.js')).MacFileManager
  if (IS_LINUX) return (await import('./filemanager-linux.js')).LinuxFileManager
  return PosixFileManager
}

const Implementation = await pickFileManager()

/** 本进程用的那一个。业务代码只认它，不再自己判平台。 */
export const fileManager = new Implementation()

/** settings.json 与日志所在的目录（老代码从 platform.js 拿的那个 APP_DIR）。 */
export const APP_DIR = fileManager.appDir

export { FileManager, PosixFileManager }
