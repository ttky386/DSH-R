/**
 * `/api/desktop` 的本机 HTTP 客户端（DSH-X 外壳借给插件的桌面能力）。
 *
 * 链路是 插件（dsh 子进程） → 管理服务 `/api/desktop/*` → 外壳 `host.desktop` → Electron。
 * 只有由 DSH-X 启动的 dsh 实例才有 `DSH_X_MANAGER_URL` + `DSH_X_DESKTOP=1`；浏览器模式、
 * 用户自己 `dsh` 起来的环境、旧外壳都没有，所以这里一律返回 `{ ok: false, reason }`，
 * 不抛异常、不重试——调用方按 `reason` 决定要不要退回页面内提示。
 *
 * 协议版本、请求形状与上限见仓库的 `docs/desktop-api.md`。
 */

/** 单次请求的超时：本机回环还要 5 秒，说明外壳已经卡住了，别让插件跟着卡。 */
const DEFAULT_TIMEOUT_MS = 5000

/**
 * 管理页的服务根地址（只留 origin）。
 *
 * `DSH_X_MANAGER_URL` 每次启动可能顺延端口，不能硬编码 3780；带路径的地址也只取 origin
 * ——管理服务的 `/api/desktop` 挂在根上。
 *
 * @param {NodeJS.ProcessEnv} [env] - 读取环境变量的对象，测试可注入。
 * @returns {string} `http://127.0.0.1:<port>` 这类 origin；不可用时是空串。
 */
export function managerOrigin(env = process.env) {
  const raw = String(env?.DSH_X_MANAGER_URL ?? '').trim()
  if (!raw) return ''
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    return url.origin
  } catch {
    return ''
  }
}

/**
 * 当前进程是否接在 DSH-X 桌面外壳上。
 *
 * 两个条件缺一不可：`DSH_X_DESKTOP === '1'`（外壳真的提供了 `host.desktop`）和管理页地址。
 * 只看到地址没有 `DSH_X_DESKTOP` 的是浏览器模式或旧外壳，不能发。
 *
 * @param {NodeJS.ProcessEnv} [env] - 读取环境变量的对象。
 * @returns {boolean} 能不能调桌面能力。
 */
export function desktopAvailable(env = process.env) {
  return String(env?.DSH_X_DESKTOP ?? '') === '1' && managerOrigin(env) !== ''
}

/**
 * 建一个桌面能力客户端。五个动作全部是 `POST` JSON，返回接口原样的 JSON。
 *
 * `notify` 的返回值值得看：`shown: false` 时 `reason` 是 `disabled`（用户关了任务通知）、
 * `throttled`（500ms 内的第二条）、`unsupported`（系统不支持通知）或 `unreachable`（调不通）。
 * `disabled` 是用户的决定，插件不该换别的通道硬发。
 *
 * @param {object} [options] - 客户端选项。
 * @param {NodeJS.ProcessEnv} [options.env] - 读取环境变量的对象。
 * @param {typeof fetch} [options.fetch] - fetch 实现，测试可注入。
 * @param {number} [options.timeoutMs] - 单次请求超时。
 * @returns {{ enabled: boolean, base: string, notify: Function, open: Function, reveal: Function, clipboard: Function, dialog: Function, info: Function }} 客户端。
 */
export function createDesktopClient({ env = process.env, fetch: fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const base = managerOrigin(env)
  const enabled = desktopAvailable(env)

  async function post(action, payload) {
    if (!enabled) return { ok: false, shown: false, reason: 'no-desktop' }
    try {
      const response = await fetchImpl(`${base}/api/desktop/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
        signal: AbortSignal.timeout(timeoutMs),
      })
      const data = await response.json().catch(() => ({}))
      // 503 是「这个外壳没有 host.desktop」，400 是请求本身不合法：都按失败原样带回去。
      return response.ok ? data : { ok: false, ...data, status: response.status }
    } catch (error) {
      return { ok: false, shown: false, reason: 'unreachable', error: error instanceof Error ? error.message : String(error) }
    }
  }

  return {
    enabled,
    base,
    notify: (payload) => post('notify', payload),
    open: (url) => post('open', { url }),
    reveal: (path) => post('reveal', { path }),
    clipboard: (text) => post('clipboard', { text }),
    dialog: (request) => post('dialog', request ?? {}),
    /**
     * 能力清单：主题、版本、通知开关。`available: false` 时别重试。
     * @returns {Promise<object>} `GET /api/desktop` 的结果。
     */
    info: async () => {
      if (!enabled) return { available: false, reason: 'no-desktop' }
      try {
        const response = await fetchImpl(`${base}/api/desktop`, { signal: AbortSignal.timeout(timeoutMs) })
        const data = await response.json().catch(() => ({}))
        return response.ok ? data : { available: false, ...data, status: response.status }
      } catch (error) {
        return { available: false, reason: 'unreachable', error: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}
