import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * 启动日志经常一次涌入几千行；逐行 stat/open/write/close 会把 Node 事件循环堵住。
 * 延迟合并小批次，达到上限就同步写出：既减少磁盘调用，也不把日志无限堆在内存里。
 * 保留同步 flush 是为了导出和退出前能确定落盘，不把最后一条崩溃线索留在异步队列中。
 */
export function createLogWriter(file, { maxBytes = 5 * 1024 * 1024, batchBytes = 64 * 1024, delay = 25 } = {}) {
  let pending = [], bytes = 0, timer = null, directoryReady = false

  function flush() {
    if (timer !== null) clearTimeout(timer)
    timer = null
    if (!pending.length) return
    const text = pending.join('')
    pending = []
    bytes = 0
    try {
      if (!directoryReady) {
        mkdirSync(dirname(file), { recursive: true })
        directoryReady = true
      }
      try {
        if (statSync(file).size > maxBytes) renameSync(file, `${file}.1`)
      } catch { /* 首次写入没有文件；轮转失败仍尽量保留当前日志。 */ }
      appendFileSync(file, text)
    } catch {
      // 和原先逐行写入一样，磁盘不可写不能拦住启动；下一批重新尝试创建目录。
      directoryReady = false
    }
  }

  return {
    append(text) {
      pending.push(text)
      bytes += Buffer.byteLength(text)
      if (bytes >= batchBytes) flush()
      else if (timer === null) {
        timer = setTimeout(flush, delay)
        timer.unref()
      }
    },
    flush,
  }
}
