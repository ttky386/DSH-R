import { registerHooks } from 'node:module'
import { load } from './patch-hooks.mjs'
import { installPluginProfile } from './plugin-profile.mjs'
import { createStartupResolver, installationRoots, STARTUP_RESOLVER } from './startup-resolver.mjs'

// 启动 CPU 账本：只在启动器给了输出目录时启用，启动窗口内采一次，结算后停。
installPluginProfile()

const resolver = createStartupResolver({
  roots: installationRoots(process.env.DSH_BIN),
  enabled: process.env.DSH_PERF_RESOLVE_CACHE !== '0',
  onEnd: process.env.DSH_PERF_DEBUG === '1'
    ? ({ hits, misses }) => console.error(`[perf] 启动相对路径缓存: 命中 ${hits}，未命中 ${misses}`) : undefined,
})
globalThis[STARTUP_RESOLVER] = resolver

// 同步补丁留在当前线程，省去异步 loader 的线程与每个模块的消息往返。
registerHooks({ load, resolve: resolver.resolve })
