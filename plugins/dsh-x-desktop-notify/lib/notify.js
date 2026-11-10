/**
 * 通知文案（纯函数，node --test 直接测）。
 *
 * 只决定「一条事件值不值得提醒、提醒什么」，发不发、发多响由外壳决定：外壳按
 * 「任务通知」「通知声音」两个开关和 500ms 节流把关，这里不重复判断。
 */

/**
 * 本轮结束原因 → 通知标题。没列出的（interrupted / forked 这类补记事件）不提醒。
 *
 * 标题写「任务已完成」而不是「DSH · 完成」：系统通知自己会显示应用名，标题再重复
 * 应用名是白占一行；用户扫一眼标题就知道是完成还是失败。
 */
const TURN_LABELS = {
  completed: '任务已完成',
  error: '任务失败',
  'max-tokens': '达到输出上限',
  blocked: '任务已阻断',
  aborted: '任务已停止',
}

/**
 * 时长文案：不到一分钟给秒，超过给 `Xm Ys`，一小时以上给 `Xh Ym`。
 * @param {number} ms - 毫秒；非有限数或负数返回空串。
 * @returns {string} 人类可读的时长。
 */
export function formatDuration(ms) {
  const total = Number(ms)
  if (!Number.isFinite(total) || total < 0) return ''
  const seconds = Math.round(total / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m${seconds % 60 ? ` ${seconds % 60}s` : ''}`
  const hours = Math.floor(minutes / 60)
  return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`
}

/** 一行正文：控制字符变空格、压空白、截到上限（通知正文最多 800 字）。 */
function line(value, max = 240) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

/** 点击通知要打开的地址：只留 http(s)，其余当没给（点了就回管理页）。 */
function urlOrEmpty(value) {
  const text = String(value ?? '').trim()
  if (!text) return ''
  try {
    const url = new URL(text)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : ''
  } catch {
    return ''
  }
}

/**
 * 一轮结束时要不要提醒、提醒什么。
 *
 * - `completed` / `error` / `max-tokens` / `blocked` 提醒；
 * - `aborted` 默认不提醒（用户自己停的），`notifyOnAborted` 可打开；
 * - `interrupted` / `forked` 是崩溃补记与 fork 边界的合成事件，不提醒。
 *
 * 正文优先放**这一轮用户说的话**（ZCode 式的「任务：…」），这样通知回答的是
 * 「我刚让它干的活怎么样了」，而不是一个孤零零的标题和秒数。拿不到人类消息
 * （cron 注入、goal 续跑、子代理）时才退回「会话标题 · 时长」。
 *
 * @param {object} input - 本轮事实。
 * @param {object} input.reason - `turn/end` 的 reason（带 kind）。
 * @param {string} [input.sessionTitle] - 会话标题，只在拿不到任务原文时用。
 * @param {string} [input.task] - 本轮用户消息原文（调用方已从 user/message 取）。
 * @param {number} [input.startedAt] - 本轮开始时间（ms），用于算时长。
 * @param {number} [input.endedAt] - 本轮结束时间（ms）。
 * @param {boolean} [input.notifyOnAborted] - 用户中止也提醒。
 * @param {string} [input.origin] - dsh 自己的地址，点击通知时进这个实例的标签页。
 * @returns {{ title: string, body: string, url?: string } | null} 通知载荷；不提醒时 null。
 */
export function turnNotice({ reason, sessionTitle = '', task = '', startedAt, endedAt, notifyOnAborted = false, origin = '' } = {}) {
  const kind = String(reason?.kind ?? '')
  if (kind === 'aborted' && notifyOnAborted !== true) return null
  const label = TURN_LABELS[kind]
  if (!label) return null

  const lines = []
  const taskText = line(task, 120)
  if (taskText) {
    lines.push(`任务：${taskText}`)
  } else {
    // 没有人类消息：至少给出是谁的会话、跑了多久。
    const parts = [line(sessionTitle) || '会话']
    const duration = formatDuration(Number(endedAt) - Number(startedAt))
    if (duration) parts.push(duration)
    lines.push(parts.join(' · '))
  }
  if (kind === 'error') {
    const message = line(reason?.error?.message, 160)
    if (message) lines.push(`错误：${message}`)
  }

  const payload = { title: label, body: lines.join('\n').slice(0, 800) }
  const url = urlOrEmpty(origin)
  if (url) payload.url = url
  return payload
}

/**
 * 工具要用户确认时的提醒。
 *
 * 审批是 agent 停下来等人的时刻，最值得一条原生通知；提醒本身不改审批结果——
 * 监听器只观察，然后原样 `next()` 交给真正的应答方。
 *
 * 和结束通知同一副骨架：标题给结论（「等你确认」），第一行是这一轮的用户原话，
 * 第二行才是「哪个工具、为什么」。先让人认出是哪个任务卡住了，再决定点不点开。
 *
 * @param {object} input - 审批事实。
 * @param {string} [input.sessionTitle] - 会话标题，只在拿不到任务原文时用。
 * @param {string} [input.task] - 这一轮用户消息原文（调用方已从 user/message 取）。
 * @param {string} [input.toolName] - 要确认的工具名。
 * @param {string} [input.reason] - 工具给的确认原因。
 * @param {string} [input.origin] - dsh 自己的地址。
 * @returns {{ title: string, body: string, url?: string }} 通知载荷。
 */
export function approvalNotice({ sessionTitle = '', task = '', toolName = '', reason = '', origin = '' } = {}) {
  const lines = []
  const taskText = line(task, 120)
  if (taskText) lines.push(`任务：${taskText}`)
  else lines.push(line(sessionTitle, 120) || '会话')

  const tool = line(toolName, 40)
  const why = line(reason, 120)
  const head = tool ? `${tool} 需要你确认` : '有一个操作需要你确认'
  lines.push(why ? `${head}：${why}` : head)

  const payload = { title: '等你确认', body: lines.join('\n').slice(0, 800) }
  const url = urlOrEmpty(origin)
  if (url) payload.url = url
  return payload
}
