/**
 * 右侧栏浏览器 guest 的租约与隔离策略。
 *
 * 这份实现直接取自官方 DSH Desktop（MIT，Copyright (c) 2026 Anywhere Labs）的
 * `dsh-desktop-next/src/browser-guests.ts`，策略逐条保留：租约一次性、partition 按 workspace、
 * `will-attach-webview` 校验后清空渲染进程传来的 webPreferences、guest 拒绝权限/下载/原生弹窗、
 * 导航只放行无凭据 HTTP(S)。和官方唯一的差别是 owner 从「应用主窗口」换成了 dsh 标签页的
 * WebContents（DSH-X 每个 dsh 实例一块 WebContentsView）。
 *
 * 官方仓库：https://github.com/anywhere-labs/dsh-desktop
 */
import { createHash, randomUUID } from 'node:crypto'
import { app, session } from 'electron'

/** 外壳 ↔ dsh 页面的 IPC 频道：preload-browser.cjs 和 main.mjs 共用。 */
export const BROWSER_IPC = Object.freeze({
  acquire: 'dsh-x:browser-acquire',
  release: 'dsh-x:browser-release',
  openRequested: 'dsh-x:browser-open-requested',
})

/** Owns workspace storage partitions independently from individual tab guests. */
export class DesktopBrowserGuests {
  /**
   * @param {() => readonly string[]} hostOrigins 当前所有 dsh 实例的 origin，guest 不能访问。
   * @param {{ ignoreCertificateErrors?: () => boolean }} [options] 证书策略（读 settings.json 的外壳开关）。
   */
  constructor(hostOrigins, { ignoreCertificateErrors = () => false } = {}) {
    this.hostOrigins = hostOrigins
    this.ignoreCertificateErrors = ignoreCertificateErrors
    this.partitions = new Map()
    this.leases = new Map()
  }

  /**
   * Reserve one guest in a workspace's process-lifetime partition.
   * @param {import('electron').WebContents} owner authenticated dsh tab WebContents.
   * @param {unknown} workspace workspace identity received over IPC.
   */
  acquire(owner, workspace) {
    if (typeof workspace !== 'string' || workspace.length === 0 || workspace.length > 4096) {
      throw new Error('desktop browser: a workspace storage identity is required')
    }
    let partition = this.partitions.get(workspace)
    if (partition === undefined) {
      // 官方桌面端用进程内临时分区（重启就掉登录态）；DSH-X 要的是「登录一次一直用」，
      // 所以按 workspace 派生一个稳定分区，交给 Electron 的 persist: 存储。
      // 名字里只放哈希，不把工作区路径写进磁盘目录名。
      const account = createHash('sha256').update(workspace).digest('hex').slice(0, 16)
      partition = `persist:dsh-sidebar-browser-${account}`
      this.configureSession(session.fromPartition(partition))
      this.partitions.set(workspace, partition)
    }
    const lease = randomUUID()
    this.leases.set(lease, { owner, partition, attached: false })
    return { lease, partition }
  }

  /**
   * Release only a lease issued to this dsh tab; workspace storage survives.
   * @param {import('electron').WebContents} owner authenticated IPC sender.
   * @param {unknown} id lease received over IPC.
   */
  async release(owner, id) {
    if (typeof id !== 'string') throw new Error('desktop browser: invalid guest lease')
    const lease = this.leases.get(id)
    if (lease === undefined) return
    if (lease.owner !== owner) throw new Error('desktop browser: guest belongs to another window')
    lease.releaseInput?.()
    this.leases.delete(id)
    const guest = lease.guest
    if (guest !== undefined && !guest.isDestroyed()) {
      const destroyed = new Promise((resolve) => { guest.once('destroyed', resolve) })
      guest.close({ waitForBeforeUnload: false })
      await destroyed
    }
  }

  /**
   * Install attachment checks before the dsh document can create a webview.
   * @param {import('electron').WebContents} owner dsh tab WebContents.
   * @param {(guest: import('electron').WebContents, name: string) => () => void} [attachInput]
   */
  bind(owner, attachInput = () => () => {}) {
    owner.on('will-attach-webview', (event, preferences, params) => {
      const id = typeof params.src === 'string' && params.src.startsWith('about:blank#')
        ? params.src.slice('about:blank#'.length) : ''
      const lease = this.leases.get(id)
      if (lease === undefined || lease.owner !== owner || lease.attached || params.partition !== lease.partition) {
        event.preventDefault()
        return
      }
      lease.attached = true
      // Keep Electron's allowpopups dispatch flag; the guest handler still denies native windows.
      for (const key of Object.keys(preferences)) {
        if (key !== 'disablePopups') Reflect.deleteProperty(preferences, key)
      }
      Object.assign(preferences, {
        partition: lease.partition,
        nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
        contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false,
        webviewTag: false, plugins: false, navigateOnDragDrop: false, disableDialogs: true,
        devTools: !app.isPackaged,
      })
      params.httpreferrer = ''
    })
    owner.on('did-attach-webview', (_event, guest) => {
      let attachedLease
      // The first document is an inert about:blank carrying the approved lease.
      // Bind on the main-process event before the renderer can navigate the ready guest.
      guest.once('dom-ready', () => {
        const url = guest.getURL()
        const id = url.startsWith('about:blank#') ? url.slice('about:blank#'.length) : ''
        const lease = this.leases.get(id)
        if (lease === undefined || lease.owner !== owner || lease.guest !== undefined) {
          guest.close({ waitForBeforeUnload: false })
          return
        }
        lease.guest = guest
        attachedLease = id
        lease.releaseInput = attachInput(guest, id)
        guest.once('destroyed', () => { lease.releaseInput?.(); this.leases.delete(id) })
      })
      guest.setWindowOpenHandler(({ url, postBody }) => {
        const lease = attachedLease === undefined ? undefined : this.leases.get(attachedLease)
        if (attachedLease !== undefined && lease?.guest === guest && lease.owner === owner && !owner.isDestroyed()
          && postBody === undefined && this.allowedNavigation(url)) {
          owner.send(BROWSER_IPC.openRequested, { lease: attachedLease, url: new URL(url).href })
        }
        return { action: 'deny' }
      })
      guest.on('will-frame-navigate', (event) => {
        if (event.isMainFrame && !this.allowedNavigation(event.url)) event.preventDefault()
      })
      guest.on('will-redirect', (event, url, _inPlace, mainFrame) => {
        if (mainFrame && !this.allowedNavigation(url)) event.preventDefault()
      })
      guest.on('will-attach-webview', (event) => { event.preventDefault() })
      guest.on('login', (event, _details, _authInfo, callback) => { event.preventDefault(); callback() })
    })
    const releaseAll = () => {
      for (const [id, lease] of this.leases) {
        if (lease.owner === owner) void this.release(owner, id).catch((error) => { console.error(error) })
      }
    }
    owner.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) releaseAll()
    })
    owner.on('render-process-gone', releaseAll)
    owner.once('destroyed', releaseAll)
  }

  configureSession(browserSession) {
    this.applyCertificatePolicy(browserSession)
    browserSession.setPermissionRequestHandler((_contents, _permission, callback) => { callback(false) })
    browserSession.setPermissionCheckHandler(() => false)
    browserSession.setDevicePermissionHandler(() => false)
    browserSession.setDisplayMediaRequestHandler((_request, callback) => { callback({}) })
    browserSession.on('will-download', (event) => { event.preventDefault() })
    browserSession.webRequest.onBeforeRequest((details, callback) => {
      let url
      try {
        url = new URL(details.url)
      } catch {
        callback({ cancel: true })
        return
      }
      const network = ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)
      callback({ cancel: network
        ? url.username !== '' || url.password !== '' || this.isApplicationHost(url)
        : !['about:', 'data:', 'blob:'].includes(url.protocol) })
    })
  }

  /**
   * 忽略证书校验只作用于内置浏览器的 guest 分区（管理页和 dsh 页面照常校验）。
   * callback(-3) 是 Electron 的「按 Chromium 默认结果走」，关掉开关时用它恢复默认校验。
   * 只在分区第一次创建时套一次策略：改设置后重启启动器才生效，不跟外壳的轮询。
   */
  applyCertificatePolicy(browserSession) {
    if (this.ignoreCertificateErrors()) browserSession.setCertificateVerifyProc((_request, callback) => callback(0))
    else browserSession.setCertificateVerifyProc((_request, callback) => callback(-3))
  }

  allowedNavigation(value) {
    if (!URL.canParse(value)) return false
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && url.username === '' && url.password === ''
      && !this.isApplicationHost(url)
  }

  isApplicationHost(url) {
    // Next may expose the same Host generation on several origins (loopback plus LAN HTTPS),
    // so every currently published Host origin is withheld from guests, not just one.
    return this.hostOrigins().some((value) => {
      if (!URL.canParse(value)) return false
      const host = new URL(value)
      return url.port === host.port
        && (url.hostname === host.hostname || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    })
  }
}
