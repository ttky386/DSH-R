/**
 * dsh 标签页的预加载：只暴露官方右侧栏浏览器需要的 `dshDesktop` 桥。
 *
 * 取自官方 DSH Desktop（MIT，Copyright (c) 2026 Anywhere Labs）的
 * `dsh-desktop-next/src/preload-browser.ts`，接口与校验逐条保留；不暴露原始 IPC、
 * Electron 对象或任何外壳通道。
 *
 * 必须是 CommonJS：沙盒里的预加载不支持 ESM。
 */
const { contextBridge, ipcRenderer } = require('electron')

const IPC = {
  acquire: 'dsh-x:browser-acquire',
  release: 'dsh-x:browser-release',
  openRequested: 'dsh-x:browser-open-requested',
}

/** Lease-scoped browser operations and one main-process event subscription per window. */
function createDesktopBrowserBridge() {
  const listeners = new Map()
  ipcRenderer.on(IPC.openRequested, (_event, request) => {
    if (typeof request !== 'object' || request === null || !('lease' in request) || !('url' in request)
      || typeof request.lease !== 'string' || typeof request.url !== 'string') return
    const callbacks = listeners.get(request.lease)
    if (callbacks === undefined) return
    for (const callback of [...callbacks]) {
      try { callback(request.url) }
      catch (error) { console.error('Desktop browser link handler failed', error) }
    }
  })
  return {
    acquire: (workspace) => ipcRenderer.invoke(IPC.acquire, workspace),
    release: (lease) => ipcRenderer.invoke(IPC.release, lease),
    onOpenRequested(lease, listener) {
      let callbacks = listeners.get(lease)
      if (callbacks === undefined) { callbacks = new Set(); listeners.set(lease, callbacks) }
      callbacks.add(listener)
      return () => {
        callbacks.delete(listener)
        if (callbacks.size === 0 && listeners.get(lease) === callbacks) listeners.delete(lease)
      }
    },
  }
}

// 官方 sidebar-browser 客户端只认 protocolVersion === 1 且带 browser 的载体；
// 没有这个对象它会静默回退到 iframe。
contextBridge.exposeInMainWorld('dshDesktop', {
  protocolVersion: 1,
  browser: createDesktopBrowserBridge(),
})
