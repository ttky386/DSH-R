import { registerHooks } from 'node:module'
import { load } from './session-events.mjs'
import { load as diagnosticLoad } from './diagnostics.mjs'
import { load as loadPluginMarket } from './plugin-market.mjs'

// 补丁只做同步字符串替换，没必要让每次模块读取都跨加载线程传递源码。
// 最低支持的 Node 22.18 已有同步钩子；worker 的兼容补丁仍走独立的 --require。
registerHooks({ load })
registerHooks({ load: diagnosticLoad })
registerHooks({ load: loadPluginMarket })
