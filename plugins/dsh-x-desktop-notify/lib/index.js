/**
 * dsh-x-desktop-notify 主机侧：把 DSH-X 外壳的原生桌面能力接进 dsh。
 *
 * 两件事：
 * 1. 自动提醒：会话一轮结束、工具等用户确认时，通过 `/api/desktop/notify` 发系统原生通知。
 *
 *    之前这类提醒只能由页面插件做（浏览器 Notification）。页面插件要渲染、要点开过窗口、
 *    后台标签页还可能被节流；host 侧直接调外壳，进程在就有通知。外壳的「任务通知」
 *    「通知声音」两个开关和 500ms 节流照常生效——用户关掉就是关掉，插件不另开通道。
 * 2. 桌面服务：把 notify / open / reveal / clipboard / dialog 五个能力作为 `dshDesktop`
 *    服务借给其它插件（`inject: ['dshDesktop']`），省得每个插件自己写一遍 HTTP。
 *
 * 不在 DSH-X 里跑时（浏览器模式、用户自己 `dsh`、旧外壳）没有 `DSH_X_MANAGER_URL` /
 * `DSH_X_DESKTOP`，客户端一律返回 `{ ok: false, reason: 'no-desktop' }`，本插件静默不做事。
 *
 * 只有 host 半部，没有 client 模块：通知不依赖页面。
 */
import { createDesktopClient } from './desktop.js'
import { approvalNotice, turnNotice } from './notify.js'

/** Diagnostic name of this Host plugin. */
export const name = 'dsh-x-desktop-notify'

/** 默认配置；patch 行里的 config 覆盖它。 */
const DEFAULT_CONFIG = {
  /** 一轮结束时提醒。 */
  onTurnEnd: true,
  /** 工具等用户确认时提醒。 */
  onApproval: true,
  /** 子代理会话的轮次也提醒；默认只提醒顶层会话，免得一条任务响一串。 */
  includeSubagents: false,
  /** 用户自己中止的轮次也提醒；默认不提醒。 */
  notifyOnAborted: false,
}

/** 正在跑的轮次：sessionId → { startedAt, task }。上限 500，够覆盖并行会话。 */
const TURN_TRACK_MAX = 500

/**
 * `user/message` 里真正由人打的那句话。
 *
 * 同一个事件类型还承载 `agent.inject()` 的合成上下文（文件变更通知、子目录
 * AGENTS.md、cron 提醒…）。`source.kind === 'user'` 才是人类直接输入；别的来源
 * 放进通知只会让人困惑「我没说过这句」。图片、附件这类块跳过，只取文本。
 *
 * @param {unknown} message - `turn/end` 之前那条 `user/message` 的 data。
 * @returns {string} 纯文本拼起来的人类输入；不是人类消息时为空串。
 */
export function userTaskText(message) {
  if (!message || typeof message !== 'object') return ''
  if (message.role !== 'user') return ''
  if (message.source?.kind !== 'user') return ''
  const blocks = Array.isArray(message.content) ? message.content : []
  return blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join(' ')
}

function normalizeConfig(input) {
  const config = { ...DEFAULT_CONFIG }
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (typeof input?.[key] === 'boolean') config[key] = input[key]
  }
  return config
}

/** 子代理会话（origin=subagent 或 delegationDepth>0）。 */
function isSubagent(session) {
  const header = session?.header
  return header?.origin === 'subagent' || (Number(header?.delegationDepth) || 0) > 0
}

/**
 * 插件入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx - cordis 上下文。
 * @param {object} [config] - patch 行里的 config。
 */
export function apply(ctx, config = {}) {
  const settings = normalizeConfig(config)
  const desktop = createDesktopClient()

  // 其它插件 inject: ['dshDesktop'] 后直接调；重名时保留先注册的那个，别把启动搞挂。
  try {
    ctx.provide('dshDesktop', desktop)
  } catch (error) {
    ctx.logger?.warn?.(`dsh-x-desktop-notify: dshDesktop 已被占用（${error instanceof Error ? error.message : String(error)}）`)
  }

  /** 本实例自己的地址；点击通知时外壳按 origin 找到正在跑的 dsh 实例，进它自己的标签页。 */
  function originOf() {
    try {
      const origin = ctx.get('webServer')?.getOrigin?.()
      return typeof origin === 'string' ? origin : ''
    } catch {
      return ''
    }
  }

  /** 会话标题：标题服务按日志折叠；没有这个服务（精简 profile）就留空。 */
  function titleOf(session) {
    try {
      return String(ctx.get('sessionTitle')?.get?.(session)?.title ?? '')
    } catch {
      return ''
    }
  }

  /** 发一条；失败不外抛，通知不该影响 turn。 */
  function send(payload) {
    if (!payload) return
    try {
      void desktop.notify(payload).catch(() => {})
    } catch {
      // 连 fetch 都起不来时当作没有桌面能力。
    }
  }

  const turnStarts = new Map()

  ctx.on('session/event', (session, event) => {
    if (!event || !session) return
    if (event.type === 'turn/start') {
      if (turnStarts.size >= TURN_TRACK_MAX) turnStarts.delete(turnStarts.keys().next().value)
      turnStarts.set(session.id, { startedAt: event.time, task: '' })
      return
    }
    // 这一轮用户到底要它干什么：turn/start 之后、真正开跑之前的那条人类消息。
    // 同一轮里后续的注入消息不覆盖，通知只认第一句人话。
    if (event.type === 'user/message') {
      const turn = turnStarts.get(session.id)
      if (turn && !turn.task) turn.task = userTaskText(event.data)
      return
    }
    if (event.type !== 'turn/end') return

    const turn = turnStarts.get(session.id)
    turnStarts.delete(session.id)
    if (!settings.onTurnEnd) return
    if (!settings.includeSubagents && isSubagent(session)) return

    send(turnNotice({
      reason: event.data?.reason,
      sessionTitle: titleOf(session),
      task: turn?.task ?? '',
      startedAt: turn?.startedAt,
      endedAt: event.time,
      notifyOnAborted: settings.notifyOnAborted,
      origin: originOf(),
    }))
  })

  // 审批是 waterfall：只观察，不抢答——原样把裁决交给真正的应答方。
  ctx.on('approval/request', (request, next) => {
    try {
      if (settings.onApproval) {
        const session = request?.agent?.session
        send(approvalNotice({
          sessionTitle: session ? titleOf(session) : '',
          // 同一个会话正在跑的那一轮：通知里先说清是哪个任务卡住了。
          task: session ? (turnStarts.get(session.id)?.task ?? '') : '',
          toolName: request?.toolName,
          reason: request?.reason,
          origin: originOf(),
        }))
      }
    } catch {
      // 提醒失败不能耽误审批。
    }
    return next()
  })

  // 会话关掉后清掉它的轮次起点，长时间跑的服务不会攒住旧 id。
  ctx.on('session/disposed', (session) => {
    if (session) turnStarts.delete(session.id)
  })
}
