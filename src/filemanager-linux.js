import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { FileManager } from './filemanager-base.js'
import { desktopEntry } from './linux-desktop.js'
import { APP_DIR_NAME, IN_ELECTRON, LAUNCHER_NAME, LINUX_BUNDLE_ID, LINUX_ICON_NAME } from './platform.js'

/** 对话框等用户的时间：和 Windows/macOS 保持一致，慢的文件系统不能把选择器提前关掉。 */
const DIRECTORY_TIMEOUT = 5 * 60 * 1000
const FILE_TIMEOUT = 10 * 60 * 1000

/**
 * Linux 这一套：XDG 目录、xdg-open、Electron 原生选择器（无外壳时退 kdialog/zenity）、
 * XDG autostart。桌面环境差异大，对话框优先用 Electron 自带的 GTK/Qt 后端；纯服务运行
 * 才落到发行版常见的选择器，避免把某一个发行版的工具写成硬依赖。
 */
export class LinuxFileManager extends FileManager {
  constructor(deps = {}) {
    super(deps)
    this.writeFile = deps.writeFile || writeFile
    this.mkdir = deps.mkdir || mkdir
    this.rm = deps.rm || rm
    // null 表示按需从 Electron 取；测试注入 undefined 时也要保持这个语义。
    this.dialog = deps.dialog !== undefined ? deps.dialog : null
  }

  get platform() { return 'linux' }

  get directoryOpener() { return 'xdg-open' }

  /** XDG_CONFIG_HOME 按规范必须是绝对路径；被环境变量塞了相对值时退 ~/.config。 */
  get configHome() {
    const configured = String(this.env.XDG_CONFIG_HOME || '')
    if (isAbsolute(configured)) return configured
    return join(this.home, '.config')
  }

  userAppDir() {
    return join(this.configHome, APP_DIR_NAME)
  }

  /**
   * 打包布局是 <安装目录>/resources/app/<本文件>，外壳在安装目录根。
   * Electron 里 process.execPath 可靠；非 Electron 只按这份布局找，源码运行不自启。
   */
  launcherExecutable() {
    if (IN_ELECTRON) return process.defaultApp ? '' : process.execPath
    // AppImage 的 process.execPath 是挂载点里的临时二进制，重启后就没了；
    // 自启必须指向 APPIMAGE 本体（electron-builder 运行时注入该变量）。
    const appImage = String(this.env.APPIMAGE || '').trim()
    if (appImage) return appImage
    // 0.1.21 起核心在 resources/core，Linux 外壳在安装根目录；兼容旧 resources/app 布局。
    for (const exe of [join(dirname(this.root), LAUNCHER_NAME), join(dirname(dirname(this.root)), LAUNCHER_NAME)]) {
      if (this.exists(exe)) return exe
    }
    return ''
  }

  get autoStartPath() {
    return join(this.configHome, 'autostart', `${LINUX_BUNDLE_ID}.desktop`)
  }

  /** 单独抽出来测转义：autostart 写坏一个字符，下次登录就会静默失效。 */
  launchDesktopEntry(args = this.launchArgs()) {
    return desktopEntry({ exec: args, icon: LINUX_ICON_NAME })
  }

  async autoStartEnabled() {
    return this.exists(this.autoStartPath)
  }

  /** XDG 只看文件存在；我们写的内容永远不是 Hidden=true，不需要解析一遍 desktop 文件。 */
  async setAutoStart(enabled) {
    const path = this.autoStartPath
    if (enabled) {
      await this.mkdir(dirname(path), { recursive: true })
      await this.writeFile(path, this.launchDesktopEntry(), 'utf8')
      return
    }
    await this.rm(path, { force: true })
  }

  async pickDirectory(initialPath = '') {
    const dialog = await this.electronDialog()
    if (dialog) {
      const result = await dialog.showOpenDialog({
        title: '选择目录',
        defaultPath: initialPath || undefined,
        properties: ['openDirectory', 'createDirectory'],
      })
      return result.canceled ? '' : (result.filePaths[0] || '')
    }
    // 外部选择器不预检 PATH：预检在注入/精简 PATH 的环境里会误杀真实存在的命令，
    // 直接试 zenity，没装（ENOENT）再换 kdialog，两个都没有才报错。
    const zenity = await this.tryDialog(['--title', 'DSH-X', '--file-selection', '--directory', '--filename', this.initialDialogPath(initialPath, true)], DIRECTORY_TIMEOUT)
    if (zenity !== null) return zenity
    const kdialog = await this.tryDialog(['--title', 'DSH-X', '--getexistingdirectory', this.initialDialogPath(initialPath)], DIRECTORY_TIMEOUT, 'kdialog')
    if (kdialog !== null) return kdialog
    throw new Error('没有可用的 Linux 目录选择器：请从 DSH-X 桌面端操作，或安装 kdialog / zenity')
  }

  async pickFile({ save = false, defaultName = '', title = '', prompt = '' } = {}) {
    const label = prompt || title || (save ? '选择保存位置' : '选择文件')
    const dialog = await this.electronDialog()
    if (dialog) {
      const options = { title: label, defaultPath: defaultName || undefined }
      const result = save
        ? await dialog.showSaveDialog(options)
        : await dialog.showOpenDialog({ ...options, properties: ['openFile'] })
      return result.canceled ? '' : (result.filePath || result.filePaths[0] || '')
    }
    const initial = this.initialDialogPath(defaultName)
    const zenityArgs = ['--title', 'DSH-X', '--file-selection', '--filename', initial]
    if (save) zenityArgs.push('--save')
    const zenity = await this.tryDialog(zenityArgs, FILE_TIMEOUT)
    if (zenity !== null) return zenity
    const kdialog = await this.tryDialog(['--title', 'DSH-X', save ? '--getsavefilename' : '--getopenfilename', initial], FILE_TIMEOUT, 'kdialog')
    if (kdialog !== null) return kdialog
    throw new Error('没有可用的 Linux 文件选择器：请从 DSH-X 桌面端操作，或安装 kdialog / zenity')
  }

  /** 在文件管理器里选中文件；FileManager1 是跨 GNOME/KDE 的标准接口，失败再打开父目录。 */
  async revealPath(path) {
    const uri = pathToFileURL(String(path)).href
    try {
      await this.openWith('dbus-send', [
        '--session',
        '--dest=org.freedesktop.FileManager1',
        '--type=method_call',
        '/org/freedesktop/FileManager1',
        'org.freedesktop.FileManager1.ShowItems',
        `array:string:${uri}`,
        'string:',
      ], { timeout: 5000 })
      return
    } catch {
      await this.openWith(this.directoryOpener, [dirname(String(path))], { timeout: 5000 })
    }
  }

  async openUrl(url) {
    await this.openWith(this.directoryOpener, [String(url)], { timeout: 15000 })
  }

  /** Electron 主进程里用原生选择器；Node 服务里 electron 包导出的是路径，不能当 API 用。 */
  async electronDialog() {
    if (this.dialog) return this.dialog
    if (!IN_ELECTRON) return null
    try {
      this.dialog = (await import('electron')).dialog
    } catch {
      this.dialog = null
    }
    return this.dialog
  }

  /** kdialog 在 KDE 上更贴合；其它桌面先试 zenity。命令存在性只看 PATH，不跑 shell。 */
  initialDialogPath(value, directory = false) {
    if (value && this.exists(value)) return String(value)
    return value || (directory ? `${this.home}/` : this.home)
  }

  /**
   * 外部选择器（zenity / kdialog）：退出码 1 是取消，返回空串；ENOENT 返回 null
   * 让调用方级联下一个；其它错误照抛，不能把崩溃伪装成取消或缺包。
   */
  async tryDialog(args, timeout, command = 'zenity') {
    let out
    try {
      out = await this.exec(command, args, { timeout, encoding: 'utf8' })
    } catch (error) {
      if (error?.code === 1) return ''
      if (error?.code === 'ENOENT') return null
      throw error
    }
    return out.trim().replace(/(.)\/+$/, '$1')
  }
}
