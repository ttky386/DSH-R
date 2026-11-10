import { realpathSync } from 'node:fs'
import { sep } from 'node:path'
import { pathToFileURL } from 'node:url'

export const STARTUP_RESOLVER = Symbol.for('dsh-x/startup-resolver')

/** 只覆盖当前内核的安装目录，Profile 自装依赖和工作区文件仍逐次走原解析器。 */
export function installationRoots(anchor) {
  if (!anchor) return []
  const paths = new Set([anchor])
  try { paths.add(realpathSync(anchor)) } catch { /* 未安装的内核不会启用缓存。 */ }
  const roots = new Set()
  for (const path of paths) {
    const marker = `${sep}node_modules${sep}`
    const at = path.lastIndexOf(marker)
    if (at < 0) continue
    roots.add(pathToFileURL(path.slice(0, at + marker.length)).href)
  }
  return [...roots]
}

/**
 * 同目录模块反复引用相同相对路径时，Node 会重复探测文件与 package.json。
 * 缓存仅在一次 runProfile 内生效，结束或失败立即清空，避免影响插件更新与热重载。
 * 不缓存裸包名：它们的 Profile 路由、条件导出和本地覆盖全部交还 dsh。
 */
export function createStartupResolver({ roots = [], enabled = true, limit = 8192, onEnd } = {}) {
  const cache = new Map()
  let depth = 0, hits = 0, misses = 0
  return {
    begin() {
      if (depth++ === 0) { cache.clear(); hits = 0; misses = 0 }
    },
    end() {
      if (!depth || --depth) return
      cache.clear()
      onEnd?.({ hits, misses })
    },
    stats: () => ({ hits, misses, size: cache.size, active: depth > 0 }),
    resolve(specifier, context, nextResolve) {
      const parent = context.parentURL
      if (!enabled || !depth || !parent || parent.includes('?') || parent.includes('#')
        || !roots.some((root) => parent.startsWith(root))
        || !(specifier.startsWith('./') || specifier.startsWith('../'))
        || Object.keys(context.importAttributes || {}).length) return nextResolve(specifier, context)
      // Node 22 的 CJS 钩子会传 Set，ESM 传数组；两者的条件都必须进入缓存键。
      const key = `${parent.slice(0, parent.lastIndexOf('/') + 1)}\0${specifier}\0${Array.from(context.conditions || []).join('\0')}`
      const found = cache.get(key)
      if (found) {
        hits++
        return { ...found, shortCircuit: true }
      }
      misses++
      const result = nextResolve(specifier, context)
      // 错误不记忆；成功也只收文件结果，不拦截用户钩子的自定义协议。
      if (result.url?.startsWith('file:') && cache.size < limit) cache.set(key, { ...result })
      return result
    },
  }
}

/** 只在已知的官方入口上包一层生命周期；上游改名/改签名就自动跳过。 */
export function patchProfileBoot(source) {
  const anchor = 'async function runProfile(options) {'
  if (!source.includes(anchor) || source.includes('__dshXRunProfile')) return source
  return source.replace(anchor, `async function runProfile(...args) {
  const cache = globalThis[Symbol.for('dsh-x/startup-resolver')];
  cache?.begin();
  try { return await __dshXRunProfile(...args); }
  finally { cache?.end(); }
}
async function __dshXRunProfile(options) {`)
}
