/**
 * 会话事件词汇兼容补丁 —— worker 线程版（CommonJS）。
 *
 * dsh 在校验会话日志时会起一个 Worker Thread 跑 `worker.cjs`，那里有一份**内联的**
 * 事件词汇表副本，且校验用的就是它。主线程的 ESM 加载钩子够不到那个文件，所以
 * 需要这个 CJS 补丁：通过 NODE_OPTIONS=--require 注入，对 worker 同样生效
 * （worker 的 `execArgv: []` 只清空命令行参数，不影响 NODE_OPTIONS）。
 *
 * 做法：拦截 fs 读取，在 worker.cjs 的源码里把那几个纯日志事件类型补进词汇表。
 * 只改内存中的字符串，不动磁盘上的任何文件；匹配不到就原样返回（dsh 升级后自动失效）。
 *
 * 覆盖 worker.cjs 里的两处：
 *   1. KNOWN_SESSION_EVENT_TYPES —— "这个事件类型认不认识"；
 *   2. 词汇表之外的等价集合（若结构不同则跳过）。
 */
'use strict'

const SESSION_TYPES = ['filesnap/point', 'filesnap/rewound', 'filesnap/redone']
const KNOWN_ANCHOR = 'const KNOWN_SESSION_EVENT_TYPES = new Set(['

/** 只处理 dsh 的会话持久化 worker。 */
function isTargetWorker(filename) {
  return typeof filename === 'string' &&
    filename.includes('dsh-session-persistence-jsonl') &&
    filename.endsWith('worker.cjs')
}

/** 给源码里的词汇表注入事件类型；已注入过或结构不符则返回 null。 */
function injectTypes(source) {
  if (source.includes(SESSION_TYPES[0])) return null
  const anchor = source.indexOf(KNOWN_ANCHOR)
  if (anchor < 0) return null
  const injected = SESSION_TYPES.map((type) => JSON.stringify(type)).join(',')
  return source.slice(0, anchor + KNOWN_ANCHOR.length) + injected + ',' + source.slice(anchor + KNOWN_ANCHOR.length)
}

// 在 fs 层拦截：worker.cjs 这类打包文件由 Node 自己读取，不经过 require 的编译钩子
let patched = null
const fs = require('node:fs')

function wrapRead(original, needsEncoding) {
  return function patchedRead(file, ...rest) {
    const result = original.call(this, file, ...rest)
    try {
      if (!isTargetWorker(typeof file === 'string' ? file : file?.toString?.())) return result
      let text = typeof result === 'string' ? result : null
      if (text === null && Buffer.isBuffer(result)) text = result.toString('utf8')
      if (text === null) return result
      const next = injectTypes(text)
      if (next === null) return result
      if (patched === null) {
        patched = true
        if (process.env.DSH_PERF_DEBUG === '1') {
          console.error('[compat] worker 会话事件词汇已补丁')
        }
      }
      return needsEncoding ? next : Buffer.from(next, 'utf8')
    } catch {
      // 任何意外都退回原始结果，绝不干扰读取
      return result
    }
  }
}

fs.readFileSync = wrapRead(fs.readFileSync, true)
fs.readFile = wrapRead(fs.readFile, false)
