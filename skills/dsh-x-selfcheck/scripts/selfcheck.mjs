#!/usr/bin/env node
/**
 * DSH-X 环境自检：一次收齐「管理页、版本目录、DSH_HOME/profile、插件、技能、日志」的状态。
 *
 * 为什么要有这个脚本，而不是让 AI 每次自己串 curl / ls：
 *  - 判断口径散在启动器里（端口从哪来、哪份 settings 生效、锁怎么算、哪个 profile 是当前值），
 *    每次现查既慢又容易漏，还容易把「端口顺延」这类正常现象当成故障；
 *  - AI 需要的是稳定的、可解析的结论：默认输出中文人读报告，--json 输出固定 schema；
 *  - 默认只读：排障时最怕「自检脚本顺手改了东西」，这里不写配置、不启停进程、不碰凭据内容。
 *
 * 边界（写清楚，免得 AI 把「查不到」当成「坏了」）：
 *  - 管理页没跑时只能看文件层：settings.json、版本目录、DSH_HOME、技能根、manager.log。
 *    实例状态、页面自检结果、插件开关这些只有管理页在跑时才查得到，脚本会明确说「没查」。
 *  - 网络默认不测（可能很慢）；只有 --net 才走管理页 /api/proxy/test（POST，本机脚本不带 Origin）。
 */
import { accessSync, constants as FS, readFileSync, readdirSync, realpathSync, statfsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const TOOL = 'dsh-x-selfcheck'
const SCHEMA_VERSION = 1
const TOOL_VERSION = '1.0.0'

const DEFAULT_PORT = 3780
const DEFAULT_PROFILE = 'web'
const LOG_TAIL_LINES = 3000
const BOOL_TRUE = new Set(['true', 'yes', 'on', '1'])
const BOOL_FALSE = new Set(['false', 'no', 'off', '0'])
const SKILL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/
const KEBAB_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const LEGACY_FRONTMATTER_KEYS = ['disableModelInvocation', 'modelInvocable', 'userInvocable']
const PROFILE_RE = /^[A-Za-z0-9._-]{1,32}$/
const PROXY_MODES = ['off', 'system', 'manual']
const OPEN_MODES = ['tab', 'app', 'window', 'internal']
const WEB_BINDS = ['loopback', 'lan']
const DOWNLOAD_SOURCES = ['mirror', 'official']
const SECTION_LABEL = {
  environment: '环境',
  manager: '管理页',
  data: '版本与数据',
  home: 'DSH_HOME / profile',
  instance: '实例',
  plugin: '插件',
  skill: '技能',
  network: '网络与同步',
  log: '日志',
}
const SECRET_MASK = '***'

/* ------------------------------------------------------------------ */
/* 基础工具：文件、格式化、脱敏、HTTP                                   */
/* ------------------------------------------------------------------ */

function readText(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function statOrNull(path) {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

function isDir(path) {
  return statOrNull(path)?.isDirectory() === true
}

function isFile(path) {
  return statOrNull(path)?.isFile() === true
}

/**
 * 系统全局装的 dsh（npm -g、Homebrew 等）不在版本目录里，却可能记在 config.json。
 * 管理页没跑、拿不到 managed 标记时用它兜底，免得把全局安装误报成「目录被删」。
 */
function detectGlobalDsh() {
  const candidates = []
  if (process.env.APPDATA) candidates.push(join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh'))
  if (process.platform === 'darwin') {
    candidates.push('/usr/local/lib/node_modules/@deepseek-ai/dsh', '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh')
  }
  if (process.platform === 'linux') {
    candidates.push('/usr/local/lib/node_modules/@deepseek-ai/dsh', '/usr/lib/node_modules/@deepseek-ai/dsh', join(homedir(), '.local/lib/node_modules/@deepseek-ai/dsh'))
  }
  for (const dir of candidates) {
    if (isDir(dir)) return dir
  }
  return ''
}

function absolutePath(value) {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  if (!text || !isAbsolute(text)) return ''
  return resolve(text)
}

function oneLine(text, max = 200) {
  return mask(String(text ?? '').replace(/\s+/g, ' ').trim()).slice(0, max)
}

function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return ''
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return hours < 48 ? `${hours}h${minutes % 60}m` : `${Math.floor(hours / 24)}d`
}

function formatLocalTime(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMinutes)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

function ageText(at) {
  if (typeof at !== 'number' || !Number.isFinite(at)) return ''
  const delta = Date.now() - at
  if (delta < 0 || delta < 60_000) return '刚刚'
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`
  return `${Math.floor(delta / 86_400_000)} 天前`
}

/**
 * 任何要进报告/JSON 的文本都过这里：dsh 的凭据常出现在子进程输出里。
 * 启动器自己的 /api/logs/export 只认它配置过的 secretValues 与 sk-/ak- 前缀；
 * 这里再兜一层常见的「配置项名=密钥」与云厂商密钥 ID 形态，否则第三方插件打出来的
 * accessKeyId / secretAccessKey 会原样进报告。
 */
export function mask(text) {
  if (text === undefined || text === null) return ''
  let out = String(text)
  // 日志中的 JSON 键和值都可能带转义；先完整消费字符串，避免只遮住引号前半段。
  // 解码仅用于识别键名，不执行日志内容，也不改动非敏感字段。
  const sensitiveKey = /^(?:(?:aws[_-])?(?:secret[_-]?access[_-]?key|secret[_-]?key|access[_-]?key(?:id)?(?:[_-]?secret)?|session[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret)|token|api[_-]?key|secret|password|passwd|authorization|cookie|set-cookie)$/i
  out = out.replace(/("(?:\\.|[^"\\])*"\s*:\s*)("(?:\\.|[^"\\])*"|[^\s,}\]{]+)/g, (match, prefix) => {
    const key = /^"(?:\\.|[^"\\])*"/.exec(prefix)?.[0]
    try {
      if (key && sensitiveKey.test(JSON.parse(key))) {
        return `${prefix}"***"`
      }
    } catch {
      // 不合法的键不冒充 JSON；后续仍按已有普通文本规则脱敏。
    }
    return match
  })
  out = out.replace(/\bsk-[A-Za-z0-9_-]{6,}/g, 'sk-***')
  out = out.replace(/\bak-[A-Za-z0-9_-]{6,}/g, 'ak-***')
  // AWS 访问密钥 ID（AKIA…）与临时凭据（ASIA…）：没有「:」或「=」也照样是凭据
  out = out.replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, 'AKIA***')
  out = out.replace(/([?&](?:token|access_token|api_key|apikey)=)[^&\s"'<>]+/gi, '$1***')
  // 认证头整体吃掉靠前的 token/凭据：Basic 是 base64（用户名:密码），Bearer 是 JWT/opaque token。
  // 不先处理的话，下面的通用「键=值」规则只掩掉 "Bearer"/"Basic" 这个词，凭据本体留在原地。
  out = out.replace(/(\bauthorization\s*:\s*)(?:basic|bearer)\s+[^\s"',;}]+/gi, '$1***')
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer ***')
  out = out.replace(/\bBasic\s+[A-Za-z0-9+/=]{8,}/gi, 'Basic ***')
  out = out.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '***')
  // Cookie / Set-Cookie 常整串带会话凭据
  out = out.replace(/(\b(?:set-cookie|cookie)\s*:\s*)[^\r\n]+/gi, '$1***')
  out = out.replace(/(\b(?:token|api[_-]?key|apikey|secret|password|passwd|authorization)\b\s*[:=]\s*["']?)[^\s"',;}]+/gi, '$1***')
  // camelCase / snake_case 的配置键（secretAccessKey、accessKeyId、sessionToken、refresh_token、
  // secret_key、accessKeySecret、aws_secret_access_key）单独认，否则上面的 \bsecret\b 匹配不到
  // 「secretAccessKey」这种整体词；aws_ 前缀也要带上。
  out = out.replace(
    /(\b(?:aws[_-])?(?:secret[_-]?access[_-]?key|secret[_-]?key|access[_-]?key(?:id)?(?:[_-]?secret)?|session[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret)\b\s*[:=]\s*["']?)[^\s"',;}]+/gi,
    '$1***',
  )
  // URL 里的 user:password@ 段
  out = out.replace(/(\/\/)[^/@\s]+@/g, '$1***@')
  return out
}

function describeFetchError(error) {
  if (error?.name === 'AbortError') return '请求超时'
  const code = error?.cause?.code || error?.code
  if (code === 'ECONNREFUSED') return '连接被拒'
  if (code === 'ECONNRESET') return '连接被重置'
  if (code === 'ENOTFOUND') return '域名解析失败'
  if (code === 'ETIMEDOUT') return '连接超时'
  // fetch 规范有一批「禁止端口」（9、25、587…），undici 直接抛 TypeError: fetch failed，cause.message='bad port'
  if (/bad port/i.test(error?.cause?.message || '')) return '端口被 HTTP 客户端禁用'
  return code || oneLine(error?.message || error, 120) || '未知错误'
}

async function requestJson(url, { method = 'GET', timeout = 6000, body = '' } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const options = { method, signal: controller.signal, headers: { accept: 'application/json' } }
    if (body) {
      options.headers['content-type'] = 'application/json'
      options.body = body
    }
    const res = await fetch(url, options)
    const text = await res.text()
    if (!res.ok) return { error: `HTTP ${res.status}`, status: res.status }
    try {
      return { value: JSON.parse(text) }
    } catch {
      return { error: '响应不是 JSON' }
    }
  } catch (error) {
    return { error: describeFetchError(error) }
  } finally {
    clearTimeout(timer)
  }
}

async function requestText(url, { timeout = 15000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: 'text/plain' } })
    const text = await res.text()
    if (!res.ok) return { error: `HTTP ${res.status}`, status: res.status }
    return { value: text }
  } catch (error) {
    return { error: describeFetchError(error) }
  } finally {
    clearTimeout(timer)
  }
}

/* ------------------------------------------------------------------ */
/* 报告                                                                */
/* ------------------------------------------------------------------ */

function createReport() {
  const checks = []
  function add(section, id, status, title, detail = '', hint = '', evidence = []) {
    checks.push({
      section,
      sectionLabel: SECTION_LABEL[section] || section,
      id,
      status,
      title: mask(title),
      detail: mask(detail),
      hint: mask(hint),
      evidence: (Array.isArray(evidence) ? evidence : [evidence]).map((line) => mask(line)).slice(0, 4),
    })
  }
  return { checks, add }
}

function summarize(report) {
  const counts = { ok: 0, info: 0, warn: 0, fail: 0 }
  for (const check of report.checks) counts[check.status] = (counts[check.status] || 0) + 1
  const verdict = counts.fail ? 'problem' : counts.warn ? 'attention' : 'ok'
  return { ...counts, verdict, exitCode: counts.fail ? 2 : counts.warn ? 1 : 0 }
}

/* ------------------------------------------------------------------ */
/* 参数                                                                */
/* ------------------------------------------------------------------ */

function usage() {
  return [
    'DSH-X 环境自检（只读）',
    '',
    '用法：node scripts/selfcheck.mjs [选项]',
    '',
    '选项：',
    '  --json            输出机器可读 JSON（给 AI 用）；不改人类报告的内容',
    '  --verbose, -v     人类报告里也列出通过的项目',
    '  --net             额外测一次外网（走管理页 /api/proxy/test）',
    '  --no-logs         跳过日志分析（日志很大时省时间）',
    '  --port <n>        管理页端口；不给就先按环境变量 PORT、再按 settings.json，最后试 3780',
    `  --profile <名称>  要检查的 profile（默认取管理页/设置里的当前值，兜底 ${DEFAULT_PROFILE}）`,
    '  -h, --help        显示本说明',
    '',
    '退出码：0 全部正常 / 1 有警告 / 2 有失败 / 3 脚本自身出错',
  ].join('\n')
}

function parseArgs(argv) {
  const opts = { json: false, verbose: false, net: false, logs: true, port: null, profile: '', help: false }
  const readValue = (index, flag) => {
    const value = argv[index]
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} 后面需要一个值`)
    return value
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--json') opts.json = true
    else if (arg === '--verbose' || arg === '-v') opts.verbose = true
    else if (arg === '--net') opts.net = true
    else if (arg === '--no-logs') opts.logs = false
    else if (arg === '--help' || arg === '-h') opts.help = true
    else if (arg === '--port') {
      const value = Number(readValue((i += 1), '--port'))
      if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error('--port 需要 1-65535 的整数')
      opts.port = value
    } else if (arg.startsWith('--port=')) {
      const value = Number(arg.slice('--port='.length))
      if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error('--port 需要 1-65535 的整数')
      opts.port = value
    } else if (arg === '--profile') {
      const value = readValue((i += 1), '--profile').trim()
      if (!PROFILE_RE.test(value) || value === '.' || value === '..') throw new Error('--profile 只能用字母、数字、点、下划线、连字符（1-32 个字符）')
      opts.profile = value
    } else if (arg.startsWith('--profile=')) {
      const value = arg.slice('--profile='.length).trim()
      if (!PROFILE_RE.test(value) || value === '.' || value === '..') throw new Error('--profile 只能用字母、数字、点、下划线、连字符（1-32 个字符）')
      opts.profile = value
    } else {
      throw new Error(`不认识的参数：${arg}（--help 看用法）`)
    }
  }
  return opts
}

/* ------------------------------------------------------------------ */
/* 平台事实（与 platform.js / settings.js 同口径）                      */
/* ------------------------------------------------------------------ */

const IS_WINDOWS = process.platform === 'win32'

function userAppDir() {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'DSH')
  if (process.platform === 'linux') {
    const configHome = process.env.XDG_CONFIG_HOME
    return join(isAbsolute(configHome) ? configHome : join(homedir(), '.config'), 'DSH')
  }
  if (process.env.APPDATA) return join(process.env.APPDATA, 'DSH')
  return ''
}

function hasInstall(dir) {
  return isFile(join(dir, 'config.json')) || isDir(join(dir, 'versions'))
}

function joinParts(...parts) {
  return join(...parts.filter((part) => typeof part === 'string' && part))
}

/* ------------------------------------------------------------------ */
/* 上下文：所有 IO 只在这里发生一次，检查函数只读 ctx                   */
/* ------------------------------------------------------------------ */

async function discoverManager(ports) {
  const found = []
  const refused = []
  const conflicts = []
  const blocked = []
  for (const port of ports) {
    const base = `http://127.0.0.1:${port}`
    const result = await requestJson(`${base}/api/ping`, { timeout: 2500 })
    if (result.value?.app === 'dsh-x') {
      found.push({ port, base, info: result.value })
      continue
    }
    if (result.value) {
      conflicts.push({ port, app: String(result.value.app ?? '未知程序'), version: result.value.version || '' })
      continue
    }
    if (result.error === '连接被拒') {
      refused.push(port)
      continue
    }
    if (result.error === '端口被 HTTP 客户端禁用') {
      // 9/25/587 这类端口 fetch 根本不会去连，不能当成「被别的程序占用」
      blocked.push(port)
      continue
    }
    conflicts.push({ port, app: '', error: result.error || '' })
  }
  return { found, refused, conflicts, blocked, candidates: ports }
}

function loadSettingsFile(appDir) {
  const path = appDir ? join(appDir, 'settings.json') : ''
  if (!path) return { path: '', exists: false, json: false, value: null, error: '' }
  if (!isFile(path)) return { path, exists: false, json: false, value: null, error: '' }
  const text = readText(path)
  if (text === null) return { path, exists: true, json: false, value: null, error: '文件读不出来（权限？）' }
  try {
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { path, exists: true, json: false, value: null, error: '顶层不是对象' }
    }
    return { path, exists: true, json: true, value: parsed, error: '' }
  } catch (error) {
    return { path, exists: true, json: false, value: null, error: oneLine(error?.message || error, 120) }
  }
}

/** 从启动日志里还原安装目录：`启动管理器 <ROOT> <ROOT>/assets/tray.ico`。 */
function installDirFromLogs(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .filter((line) => line.includes('启动管理器'))
  const last = lines[lines.length - 1]
  if (!last) return ''
  const rest = last.replace(/^.*?启动管理器\s+/, '').trim()
  const trayRe = /[\\/]assets[\\/]tray\.ico\s*$/
  const trayMatch = trayRe.exec(rest)
  if (trayMatch) {
    // rest = <ROOT> + ' ' + <ROOT> + 托盘图标路径；两段 <ROOT> 完全相同
    const secondRootEnd = rest.length - trayMatch[0].trimEnd().length
    const split = (secondRootEnd - 1) / 2
    if (Number.isInteger(split) && rest[split] === ' ' && rest.slice(0, split) === rest.slice(split + 1, secondRootEnd)) {
      return rest.slice(0, split)
    }
  }
  return isDir(rest) ? rest : ''
}

async function collectLogs(appDir, manager, opts) {
  if (!opts.logs) return { source: '', text: '', error: '按参数跳过', skipped: true }
  if (manager) {
    const result = await requestText(`${manager.base}/api/logs/export`, { timeout: 15000 })
    if (!result.error) {
      return { source: `管理页 /api/logs/export（${formatBytes(Buffer.byteLength(result.value, 'utf8'))}，服务端已脱敏）`, text: result.value, error: '', skipped: false }
    }
    if (opts.port) {
      return { source: `${manager.base}/api/logs/export`, text: '', error: result.error }
    }
    const fallback = readLogFiles(appDir)
    return {
      ...fallback,
      source: fallback.text ? `${fallback.source}（接口失败：${result.error}，退回读本地文件）` : fallback.source,
    }
  }
  if (opts.port) {
    return { source: '', text: '', error: '指定管理页未连接，未读取其他环境的日志' }
  }
  return readLogFiles(appDir)
}

function readLogFiles(appDir) {
  const file = appDir ? join(appDir, 'manager.log') : ''
  if (!file) return { source: '', text: '', error: '定位不到日志文件' }
  const chunks = []
  for (const path of [`${file}.1`, file]) {
    const text = readText(path)
    if (text) chunks.push(text)
  }
  if (!chunks.length) return { source: '', text: '', error: `没有日志文件（${file}）` }
  // 本地文件没有服务端脱敏，但进报告前每一行都会过 mask()；这里不再整段打印。
  return { source: `本地日志 ${file}（.1 + 当前）`, text: chunks.join(''), error: '' }
}

async function buildContext(opts) {
  const startedAt = Date.now()
  const appDir = opts.port ? '' : userAppDir()
  const ctx = { startedAt, opts, appDir, settingsFile: null, settings: {}, manager: null, state: null }

  ctx.settingsFile = opts.port
    ? { path: '', exists: false, json: false, value: null, error: '指定管理页的设置文件位置及原始内容未核实' }
    : loadSettingsFile(appDir)
  ctx.settings = ctx.settingsFile.value || {}

  const envPort = Number(process.env.PORT || 0)
  const settingsPort = Number(ctx.settings.port)
  const storedPort = Number.isInteger(settingsPort) && settingsPort > 0 && settingsPort <= 65535 ? settingsPort : 0
  const candidates = opts.port
    ? [opts.port]
    : [...new Set([Number.isInteger(envPort) && envPort > 0 ? envPort : null, storedPort, DEFAULT_PORT].filter(Boolean))]
  ctx.portCandidates = candidates
  ctx.envPort = Number.isInteger(envPort) && envPort > 0 ? envPort : null
  ctx.settingsPort = storedPort

  const discovery = await discoverManager(candidates)
  ctx.discovery = discovery
  ctx.manager = discovery.found[0] || null

  if (ctx.manager) {
    const base = ctx.manager.base
    const [stateResult, selfResult, settingsResult] = await Promise.all([
      requestJson(`${base}/api/state`, { timeout: 8000 }),
      requestJson(`${base}/api/self`, { timeout: 12000 }),
      opts.port ? requestJson(`${base}/api/settings`, { timeout: 8000 }) : Promise.resolve(null),
    ])
    if (opts.port) {
      const value = settingsResult?.value
      const valid = value && typeof value === 'object' && !Array.isArray(value) && value.listenPort === ctx.manager.port
      ctx.settingsResult = valid ? settingsResult : { error: settingsResult?.error || '目标设置缺少匹配的监听端口证据' }
      ctx.settings = valid ? value : {}
      ctx.settingsPort = valid ? Number(value.port || 0) : 0
    }
    ctx.state = stateResult.value || null
    ctx.stateError = stateResult.error || ''
    ctx.selfResult = selfResult
    const profile = opts.profile || ctx.state?.profile || ctx.settings.profile || DEFAULT_PROFILE
    const [pluginsResult, skillsResult, syncResult] = await Promise.all([
      requestJson(`${base}/api/plugins?profile=${encodeURIComponent(profile)}`, { timeout: 8000 }),
      requestJson(`${base}/api/skills`, { timeout: 8000 }),
      requestJson(`${base}/api/sync`, { timeout: 8000 }),
    ])
    ctx.pluginsResult = pluginsResult
    ctx.skillsResult = skillsResult
    ctx.syncResult = syncResult
  }

  ctx.logs = await collectLogs(appDir, ctx.manager, opts)
  ctx.installDir = installDirFromLogs(ctx.logs.text) || (opts.port ? '' : installDirFromAppDir(appDir))

  // 版本目录：管理页的 DATA 最权威，其次 settings，再按启动器同款规则推断
  const stateDataDir = absolutePath(ctx.state?.dataDir)
  const settingsDataDir = absolutePath(ctx.settings.dataDir)
  const envDataDir = opts.port ? '' : absolutePath(process.env.DSH_VERSIONS_DATA)
  if (stateDataDir) ctx.dataDir = { dir: stateDataDir, source: '管理页 /api/state' }
  else if (typeof ctx.settings.dataDir === 'string' && ctx.settings.dataDir.trim()) {
    ctx.dataDir = settingsDataDir
      ? { dir: settingsDataDir, source: opts.port ? '管理页 /api/settings' : 'settings.json 的 dataDir' }
      : { dir: '', source: `settings.json 的 dataDir「${oneLine(ctx.settings.dataDir, 80)}」不是绝对路径，会被忽略` }
  } else if (envDataDir) ctx.dataDir = { dir: envDataDir, source: '环境变量 DSH_VERSIONS_DATA' }
  else ctx.dataDir = opts.port
    ? { dir: '', source: '指定管理页未提供版本目录证据' }
    : { dir: inferDataDir(ctx), source: '按启动器规则推断' }

  ctx.dshHome = resolveDshHome(ctx)
  ctx.profiles = resolveProfiles(ctx)
  ctx.profile = opts.profile || ctx.state?.profile || ctx.settings.profile || DEFAULT_PROFILE
  ctx.profileDir = ctx.dshHome.dir ? join(ctx.dshHome.dir, 'profiles', ctx.profile) : ''
  ctx.dshHomes = resolveExtraHomes(ctx)
  return ctx
}

function installDirFromAppDir(appDir) {
  // 启动器安装目录与每用户目录没有固定关系；只知道 DSH.exe 一般不是装在 %APPDATA% 里。
  return ''
}

function inferDataDir(ctx) {
  const local = ctx.installDir ? join(ctx.installDir, 'data') : ''
  const roaming = ctx.appDir ? join(ctx.appDir, 'data') : ''
  const packaged = Boolean(ctx.installDir && IS_WINDOWS && (isFile(join(ctx.installDir, 'DSH.exe')) || isDir(join(ctx.installDir, 'node'))))
  if (!packaged && local && hasInstall(local)) return local
  if (roaming && hasInstall(roaming)) return roaming
  if (packaged && roaming) return roaming
  return local || roaming
}

function resolveDshHome(ctx) {
  const fromState = absolutePath(ctx.state?.dshHome)
  if (fromState) return { dir: fromState, source: '管理页 /api/state' }
  const fromSettings = absolutePath(ctx.settings.dshHome)
  if (fromSettings) return { dir: fromSettings, source: ctx.opts.port ? '管理页 /api/settings' : 'settings.json 的 dshHome' }
  if (ctx.opts.port) {
    return { dir: '', source: '指定管理页未提供 DSH_HOME 证据' }
  }
  return { dir: join(homedir(), '.dsh'), source: '默认 ~/.dsh' }
}

function resolveProfiles(ctx) {
  const fromState = Array.isArray(ctx.state?.profiles) ? ctx.state.profiles : []
  if (fromState.length) return [...fromState].sort()
  if (!ctx.dshHome.dir) {
    return []
  }
  const dir = join(ctx.dshHome.dir, 'profiles')
  // 与启动器 listProfiles（server.js:3980-3993）同口径：跳 node_modules 与点开头目录，
  // 目录里必须有 package.json 才算 profile —— 否则 pnpm 的 node_modules 会被当成 profile 报出来。
  const names = new Set()
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      if (isFile(join(dir, entry.name, 'package.json'))) names.add(entry.name)
    }
  } catch {
    /* 还没有 profiles 目录 */
  }
  // 启动器里当前 profile 始终在列（首次启动 dsh 会按模板初始化它）
  if (ctx.profile) names.add(ctx.profile)
  return [...names].sort()
}

function resolveExtraHomes(ctx) {
  const raw = Array.isArray(ctx.state?.dshHomes) && ctx.state.dshHomes.length ? ctx.state.dshHomes : ctx.settings.dshHomes
  const homes = []
  const seen = new Set()
  for (const item of Array.isArray(raw) ? raw : []) {
    const home = absolutePath(item)
    if (!home || home === ctx.dshHome.dir) continue
    const key = IS_WINDOWS ? home.toLowerCase() : home
    if (seen.has(key)) continue
    seen.add(key)
    homes.push(home)
  }
  return homes
}

/* ------------------------------------------------------------------ */
/* 检查：环境                                                          */
/* ------------------------------------------------------------------ */

function validateSettings(settings) {
  const issues = []
  const put = (message) => issues.push(message)
  const portValid = (value) => Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 65535
  if ('port' in settings && !portValid(settings.port)) put(`port=「${oneLine(settings.port, 40)}」不是 1-65535 的整数，会退回 ${DEFAULT_PORT}`)
  if ('profile' in settings && (typeof settings.profile !== 'string' || !PROFILE_RE.test(settings.profile) || settings.profile === '.' || settings.profile === '..')) {
    put(`profile=「${oneLine(settings.profile, 40)}」不是合法 profile 名，会退回 ${DEFAULT_PROFILE}`)
  }
  if ('proxyMode' in settings && !PROXY_MODES.includes(String(settings.proxyMode).toLowerCase())) put(`proxyMode=「${oneLine(settings.proxyMode, 40)}」不认识，会退回 system（跟随系统代理）`)
  if ('openMode' in settings && !OPEN_MODES.includes(String(settings.openMode))) put(`openMode=「${oneLine(settings.openMode, 40)}」不认识，会退回 internal`)
  if ('webBind' in settings && !WEB_BINDS.includes(String(settings.webBind))) put(`webBind=「${oneLine(settings.webBind, 40)}」不认识，会退回 loopback`)
  if ('downloadSource' in settings && !DOWNLOAD_SOURCES.includes(String(settings.downloadSource))) put(`downloadSource=「${oneLine(settings.downloadSource, 40)}」不认识，会退回 mirror`)
  for (const key of ['dataDir', 'dshHome']) {
    if (!(key in settings)) continue
    const value = settings[key]
    if (value === '' || value === null || value === undefined) continue
    if (typeof value !== 'string' || !absolutePath(value)) put(`${key}=「${oneLine(value, 60)}」不是绝对路径，会被忽略`)
  }
  if (Array.isArray(settings.dshHomes)) {
    for (const item of settings.dshHomes) {
      if (item === '' || item === null || item === undefined) continue
      if (typeof item !== 'string' || !absolutePath(item)) put(`dshHomes 里有不是绝对路径的项「${oneLine(item, 60)}」，会被忽略`)
    }
  }
  if (settings.instancePorts !== undefined) {
    if (!settings.instancePorts || typeof settings.instancePorts !== 'object' || Array.isArray(settings.instancePorts)) {
      put('instancePorts 不是对象，会被重置')
    } else {
      for (const [key, value] of Object.entries(settings.instancePorts)) {
        if (!portValid(value)) put(`instancePorts["${oneLine(key, 60)}"]=${oneLine(value, 20)} 不是合法端口，这条钉子会失效`)
      }
    }
  }
  if ('autoDisablePlugins' in settings && typeof settings.autoDisablePlugins !== 'boolean') put('autoDisablePlugins 不是布尔值，会被当成默认值 true')
  if ('autoStart' in settings && typeof settings.autoStart !== 'boolean') put('autoStart 不是布尔值，会被当成默认值 false')
  return issues
}

function checkEnvironment(report, ctx) {
  report.add(
    'environment',
    'platform',
    'info',
    '运行平台',
    `${process.platform} · ${process.arch} · Node ${process.version}（脚本用内置模块，零依赖）`,
  )

  if (ctx.opts.port) {
    report.add('environment', 'app-dir', 'info', '目标设置文件来源未核实', ctx.settingsFile.error, '仅使用指定管理页返回的有效设置；未读取当前终端的设置或日志')
  } else if (!ctx.appDir) {
    report.add(
      'environment',
      'app-dir',
      'warn',
      '找不到启动器的每用户目录',
      '当前不是受支持的桌面平台，无法定位 settings.json 与 manager.log',
      '确认在 Windows、macOS 或 Linux 上运行；源码运行时启动器会把数据放在安装目录的 data/ 下',
    )
  } else if (!isDir(ctx.appDir)) {
    report.add(
      'environment',
      'app-dir',
      'warn',
      '启动器数据目录不存在',
      `预期 ${ctx.appDir}`,
      '说明管理页可能从没在这台机器上启动过；先跑 npm start 或安装版 DSH.exe，再看自检',
    )
  } else {
    report.add('environment', 'app-dir', 'ok', '启动器数据目录', ctx.appDir)
  }

  if (ctx.opts.port) {
    const detail = ctx.settingsResult?.error || (ctx.manager
      ? `${ctx.manager.base}/api/settings（原始设置文件语法未验证）`
      : '指定管理页未连接，未读取当前终端的设置')
    report.add('environment', 'settings', ctx.settingsResult?.value ? 'info' : 'warn', ctx.settingsResult?.value ? '已读取目标管理页有效设置' : '目标管理页设置未取得', detail)
  } else if (ctx.settingsFile.exists && ctx.settingsFile.json) {
    report.add('environment', 'settings', 'ok', 'settings.json 合法', ctx.settingsFile.path)
    const issues = validateSettings(ctx.settings)
    if (issues.length) {
      report.add('environment', 'settings-values', 'warn', `settings.json 里有 ${issues.length} 处值会失效或退回默认`, issues.join('；'), '在管理页「设置」里改一遍就会写回干净值；手改过的话重点看这里')
    }
  } else if (ctx.settingsFile.exists) {
    report.add(
      'environment',
      'settings',
      'warn',
      'settings.json 不是合法 JSON',
      `${ctx.settingsFile.path}：${ctx.settingsFile.error}`,
      '管理页会用默认值兜底，但你的端口/数据目录等设置都不再生效；在管理页设置里改一项即可重写',
    )
  } else if (ctx.appDir) {
    report.add(
      'environment',
      'settings',
      'warn',
      '没有 settings.json',
      `预期 ${join(ctx.appDir, 'settings.json')}`,
      '启动器第一次运行后会生成；管理页明明在跑却没有它，说明文件被删或路径不对',
    )
  }

  if (ctx.installDir && isDir(ctx.installDir)) {
    const packaged = isFile(join(ctx.installDir, 'DSH.exe')) || isFile(join(ctx.installDir, 'DSH')) || isDir(join(ctx.installDir, 'node'))
    const missingRuntime = packaged && !isDir(join(ctx.installDir, 'node'))
    report.add(
      'environment',
      'install-dir',
      missingRuntime ? 'warn' : 'ok',
      '安装目录',
      `${ctx.installDir}（${packaged ? '安装版，含原生外壳' : '源码运行'}）`,
      missingRuntime ? '安装目录里没有 node/ 自带运行时，打包/安装不完整；重新安装一次' : '',
    )
  } else if (ctx.installDir) {
    report.add(
      'environment',
      'install-dir',
      'info',
      '日志里的安装目录已不存在',
      ctx.installDir,
      '可能换过安装位置；以管理页或当前进程为准，不影响已装版本',
    )
  } else {
    const reason = ctx.logs.skipped ? '日志分析被 --no-logs 跳过，安装目录平常从日志首行识别' : '日志里没有「启动管理器」记录（可能还没启动过）'
    report.add('environment', 'install-dir', 'info', '安装目录未识别', reason, '安装目录只影响“这份代码/运行时从哪来”的判断；不影响已装版本和实例')
  }

  // Node 版本只作提示：脚本本身只要求 18+，但仓库开发要求 22.18+
  const major = Number(process.versions.node.split('.')[0])
  const minor = Number(process.versions.node.split('.')[1] || 0)
  if (major < 22 || (major === 22 && minor < 18)) {
    report.add('environment', 'node-version', 'info', `Node ${process.version} 低于仓库要求的 22.18`, '', '只是开发环境的要求；自检脚本本身在 18+ 就能跑。若管理页在跑，以它自带的 node/ 运行时为准')
  }
}

/* ------------------------------------------------------------------ */
/* 检查：管理页                                                        */
/* ------------------------------------------------------------------ */

function checkManager(report, ctx) {
  const discovery = ctx.discovery
  if (ctx.manager) {
    const viaEnv = ctx.envPort && ctx.envPort === ctx.manager.port
    const viaSettings = ctx.settingsPort && ctx.settingsPort === ctx.manager.port
    const source = ctx.opts.port ? '端口由 --port 明确指定' : viaEnv ? '端口来自环境变量 PORT' : viaSettings ? '端口来自 settings.json' : '端口是兜底值'
    report.add(
      'manager',
      'manager-up',
      'ok',
      '管理页在跑',
      `${ctx.manager.base} · 启动器 v${ctx.manager.info.version || '未知'} · ${source}`,
    )
  } else {
    const tried = discovery.candidates.map((port) => `127.0.0.1:${port}`).join('、')
    report.add(
      'manager',
      'manager-down',
      'warn',
      '管理页没在跑',
      `探测过 ${tried} 都没有响应`,
      '实例状态、页面自检、插件开关、技能列表只有管理页在跑时才查得到；需要的话先启动 DSH.exe 或 npm start 再跑一次',
    )
  }

  if (discovery.conflicts.length) {
    const lines = discovery.conflicts.map((item) => {
      const what = item.app ? `「${item.app}」v${item.version || '?'}` : item.error || '有响应但不是管理页'
      return `127.0.0.1:${item.port} → ${what}`
    })
    report.add(
      'manager',
      'port-conflict',
      'warn',
      `端口被其它程序占用（${lines.length} 个）`,
      lines.join('；'),
      '管理页会顺延到别的端口，旧链接会连不上；确认占用程序，或在设置里换一个端口',
    )
  }

  if (discovery.blocked.length) {
    report.add(
      'manager',
      'port-blocked',
      'info',
      '跳过了 HTTP 客户端禁用的端口',
      discovery.blocked.map((port) => `127.0.0.1:${port}`).join('、'),
      '这些端口（9、25、587 等）被 fetch 规范禁用，不是管理页；换 --port 或检查设置里的端口',
    )
  }

  const self = ctx.selfResult?.value
  if (self && typeof self.current === 'string') {
    if (self.update === true) {
      report.add('manager', 'self-update', 'info', '启动器有新版', `当前 ${self.current}，最新 ${self.latest || '未知'}`, `管理页里可以更新；下载地址 ${oneLine(self.url || '', 160)}`)
    } else {
      report.add('manager', 'self-update', 'ok', '启动器已是最新', `当前 ${self.current}${self.latest ? `（最新 ${self.latest}）` : ''}`)
    }
  } else if (ctx.selfResult?.error) {
    report.add('manager', 'self-update', 'info', '没查到启动器更新', `检查更新失败：${ctx.selfResult.error}`, '常见原因是网络/代理；不影响本地功能')
  }

  if (ctx.stateError) {
    report.add('manager', 'state-error', 'warn', '管理页在跑，但读不到状态', ctx.stateError, '管理页进程活着、/api/state 却失败（可能正忙、卡住或版本不匹配）；先看管理页日志，必要时重启管理页，别按「没在跑」处理')
  }
  if (ctx.state) {
    if (ctx.state.installing || ctx.state.progress) {
      report.add('manager', 'installing', 'info', '管理页正在安装', `进度 ${oneLine(JSON.stringify(ctx.state.progress), 200)}`, '等安装结束再判断别的')
    }
    if (ctx.state.pluginProgress) {
      report.add('manager', 'plugin-busy', 'info', '管理页正在操作插件', `profile ${ctx.state.pluginProgress.profile || '?'} · ${ctx.state.pluginProgress.name || '操作中'}`, '等它结束再改插件')
    }
    const pinIssues = checkPortPins(ctx)
    if (pinIssues.length) report.add('manager', 'port-pins', 'info', '固定端口的配置', pinIssues.join('；'), '固定端口只影响 dsh 实例，与管理页端口无关')
  }
}

/** 钉住的实例端口：有没有重复、和当前实例实际端口是否一致。 */
function checkPortPins(ctx) {
  const pins = ctx.state?.instancePorts || ctx.settings.instancePorts
  if (!pins || typeof pins !== 'object' || Array.isArray(pins)) return []
  const lines = []
  const byPort = new Map()
  for (const [key, value] of Object.entries(pins)) {
    const port = Number(value)
    if (!Number.isInteger(port)) continue
    lines.push(`${key} → ${port}`)
    const existing = byPort.get(port) || []
    existing.push(key)
    byPort.set(port, existing)
  }
  const conflicts = [...byPort.entries()].filter(([, keys]) => keys.length > 1)
  if (conflicts.length) {
    lines.push(`冲突：${conflicts.map(([port, keys]) => `${port} 被 ${keys.join('、')} 同时钉住`).join('；')}；后启动的会 EADDRINUSE`)
  }
  if (ctx.settingsPort && byPort.has(ctx.settingsPort)) {
    lines.push(`注意：有实例钉在 ${ctx.settingsPort}，和管理页端口相同，两者会互相抢`)
  }
  return lines
}

/* ------------------------------------------------------------------ */
/* 检查：版本与数据目录                                                */
/* ------------------------------------------------------------------ */

function managedBin(dataDir, version) {
  return join(dataDir, 'versions', version, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}

function freeBytes(dir) {
  try {
    const stats = statfsSync(dir)
    if (typeof stats.bavail === 'number' && typeof stats.bsize === 'number') return stats.bavail * stats.bsize
  } catch {
    /* 有的平台/文件系统不实现 statfs，按未知处理 */
  }
  return null
}

function readableDir(path) {
  try {
    accessSync(path, FS.R_OK)
    return true
  } catch {
    return false
  }
}

function writableDir(path) {
  try {
    accessSync(path, FS.W_OK)
    return true
  } catch {
    return false
  }
}

function checkData(report, ctx) {
  const dataDir = ctx.dataDir.dir
  if (!dataDir) {
    report.add('data', 'data-dir', 'warn', '版本目录未确定', ctx.dataDir.source || '设置里没有 dataDir，也无法按安装目录推断', '在管理页「设置 → 版本目录」里指定一个绝对路径，或先装一个 dsh 版本')
    return
  }
  if (!isDir(dataDir)) {
    report.add('data', 'data-dir', 'warn', '版本目录不存在', dataDir, '还没装过 dsh 版本，或设置里的路径已失效；在管理页「设置 → 版本目录」确认')
    return
  }
  if (!readableDir(dataDir)) {
    report.add('data', 'data-dir', 'fail', '版本目录读不了', dataDir, '权限问题；启动器会启动失败，检查目录权限或换一个位置')
    return
  }
  const writable = writableDir(dataDir)
  report.add(
    'data',
    'data-dir',
    writable ? 'ok' : 'fail',
    '版本目录',
    `${dataDir}（来源：${ctx.dataDir.source}）`,
    writable ? '' : '目录不可写：装版本、写 config.json 都会失败；确认权限或改到用户目录下',
  )

  const free = freeBytes(dataDir)
  if (free !== null) {
    const low = free < 1.5 * 1024 ** 3
    report.add('data', 'disk-space', low ? 'warn' : 'info', '剩余磁盘空间', `${formatBytes(free)} 可用`, low ? '一个 dsh 版本就要几百 MB，装新版本/更新时可能不够；清理 data/versions 里不用的版本或 release/' : '')
  }

  const versionsDir = join(dataDir, 'versions')
  let versionDirs = []
  try {
    versionDirs = readdirSync(versionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort()
  } catch {
    /* 目录不存在时下面统一提示 */
  }

  // 管理页的 managed 标记能区分「自己装的版本」和「系统全局 dsh」，优先用
  const stateVersions = Array.isArray(ctx.state?.versions) ? ctx.state.versions : []
  const managedState = new Map(stateVersions.map((item) => [String(item.version), item.managed === true]))
  const broken = versionDirs.filter((version) => !isFile(managedBin(dataDir, version)))
  const managedDirs = versionDirs.filter((version) => managedState.get(version) !== false)

  if (!versionDirs.length) {
    report.add('data', 'versions-empty', 'info', '版本目录里还没有 dsh 版本', versionsDir, '在管理页「版本」里装一个即可')
  } else {
    report.add(
      'data',
      'versions',
      broken.length ? 'warn' : 'ok',
      `已装 ${versionDirs.length} 个 dsh 版本`,
      versionDirs.join('、'),
      broken.length ? '' : '',
    )
    if (broken.length) {
      report.add(
        'data',
        'versions-broken',
        'warn',
        `${broken.length} 个版本目录不完整`,
        broken.map((version) => `${version}：缺 node_modules/@deepseek-ai/dsh/lib/bin.js`).join('；'),
        '这些版本启动会报「找不到官方入口 lib/bin.js」；在管理页重装或删除',
      )
    }
    // 只对「启动器自己该管的版本」提示，系统全局 dsh 不归版本目录管
    if (managedDirs.length) {
      const unmanaged = versionDirs.filter((version) => managedState.get(version) === false)
      if (unmanaged.length) {
        report.add('data', 'versions-system', 'info', '版本目录里有系统全局 dsh 的版本', unmanaged.join('、'), '它们不在版本目录里装依赖，属于系统 dsh；启动器只做展示/调用')
      }
    }
  }

  const configPath = join(dataDir, 'config.json')
  if (isFile(configPath)) {
    const text = readText(configPath)
    let config = null
    let error = ''
    try {
      config = JSON.parse(text)
    } catch {
      error = '不是合法 JSON'
    }
    if (error) {
      report.add('data', 'config-json', 'warn', 'config.json 解析失败', `${configPath}：${error}`, '管理页会用 scanInstalled 兜底，但「已装版本」列表可能对不上；删掉它或用管理页装/删一次会重写')
    } else {
      const listed = Array.isArray(config?.versions) ? config.versions.map(String) : []
      const missingOnDisk = listed.filter((version) => !versionDirs.includes(version))
      const extraOnDisk = versionDirs.filter((version) => !listed.includes(version))
      if (!ctx.state) {
        // 没有管理页时拿不到 managed 标记：config 里记的可能是系统全局 dsh（它本来就不在版本目录里），
        // 这里必须按「无法区分」报 info，不能报成「目录被删了」，否则会误导用户去删全局安装。
        if (missingOnDisk.length || extraOnDisk.length) {
          const parts = []
          if (missingOnDisk.length) parts.push(`config 记录但磁盘没有：${missingOnDisk.join('、')}`)
          if (extraOnDisk.length) parts.push(`磁盘上有但 config 没记录：${extraOnDisk.join('、')}`)
          const globalDsh = ctx.opts.port ? '' : detectGlobalDsh()
          const note = globalDsh
            ? `检测到系统全局 dsh（${globalDsh}），这些版本很可能就是它，不是被删了`
            : '未取得管理页版本状态，分不清「系统全局 dsh」和「目录被手动删掉」'
          report.add('data', 'config-versions', 'info', 'config.json 与版本目录有出入', `${parts.join('；')}（${note}）`, '先别按缺失删除；启动管理页后再跑一次，它会按 managed 标记判断')
        } else {
          report.add('data', 'config-json', 'ok', 'config.json 与已装版本一致', `${configPath}（${listed.length} 个版本）`)
        }
      } else {
        const realMissing = missingOnDisk.filter((version) => managedState.get(version) !== false)
        if (realMissing.length) {
          report.add('data', 'config-versions', 'warn', 'config.json 里有版本在磁盘上不存在', realMissing.join('、'), '可能是手动删过目录；管理页里删除/重装这些版本，或让它重新扫描')
        } else if (missingOnDisk.length || extraOnDisk.length) {
          const lines = []
          if (missingOnDisk.length) lines.push(`config 记录但未安装：${missingOnDisk.join('、')}（系统全局 dsh，正常）`)
          if (extraOnDisk.length) lines.push(`磁盘上有但 config 没记录：${extraOnDisk.join('、')}`)
          report.add('data', 'config-versions', 'info', 'config.json 与版本目录有出入', lines.join('；'), '通常不用处理；管理页每次启动会重新扫目录')
        } else {
          report.add('data', 'config-json', 'ok', 'config.json 与已装版本一致', `${configPath}（${listed.length} 个版本）`)
        }
      }
    }
  } else {
    report.add('data', 'config-json', 'info', '没有 config.json', configPath, '还没装过版本时会这样；装一个版本后自动生成')
  }
}

/* ------------------------------------------------------------------ */
/* 检查：DSH_HOME 与 profile                                           */
/* ------------------------------------------------------------------ */

/**
 * 补丁层是否仍是顶层条目列表：照 launcher `plugins.js` 的 looksLikeEntryList，
 * 只把「顶格、但不是 `- ` 开头」的行当坏结构；两空格缩进的键（disabled 等）是正常的。
 */
function looksLikeEntryList(text) {
  const lines = String(text || '').split(/\r?\n/).filter((line) => line.trim() !== '' && !line.trim().startsWith('#'))
  if (!lines.length) return true
  if (lines.length === 1 && /^\[\s*\]$/.test(lines[0].trim())) return true
  if (lines.some((line) => /^\S/.test(line) && !line.startsWith('- '))) return false
  if (lines.some((line) => /^\[\s*\]$|^\{\s*\}$/.test(line.trim()))) return false
  return true
}

/** 补丁层里 disabled: true 的 loader 行 id（照 launcher readPatchState 的行扫描口径）。 */
function readPatchDisables(patchPath) {
  const text = readText(patchPath)
  if (text === null) return []
  const disables = []
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^- id:\s*['"]?([A-Za-z0-9_.-]+)['"]?\s*$/.exec(lines[index] ?? '')
    if (!match) continue
    // 一条 patch 行是 YAML 映射，只认正好两个缩进的 disabled —— 再深一级是 config 里的同名字段
    for (let cursor = index + 1; cursor < lines.length && !/^- /.test(lines[cursor] ?? ''); cursor += 1) {
      const flag = /^ {2}disabled:\s*(true|false)\s*$/.exec(lines[cursor] ?? '')
      if (!flag) continue
      if (flag[1] === 'true') disables.push(match[1])
      break
    }
  }
  return disables
}

function lockOwnerActive(lockPath) {
  const text = readText(lockPath)
  if (text === null) return true
  const pid = Number.parseInt(text.trim(), 10)
  if (!Number.isInteger(pid) || pid <= 0) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code !== 'ESRCH'
  }
}

function listPatchBackups(profileDir) {
  try {
    return readdirSync(profileDir)
      .filter((name) => name.startsWith('cordis.patch.yml.bak-'))
      .sort()
      .reverse()
  } catch {
    return []
  }
}

function checkHome(report, ctx) {
  const home = ctx.dshHome.dir
  if (!home) {
    report.add('home', 'dsh-home', 'warn', 'DSH_HOME 未确定', ctx.dshHome.source)
    return
  }
  if (!isDir(home)) {
    report.add('home', 'dsh-home', 'warn', 'DSH_HOME 不存在', `${home}（来源：${ctx.dshHome.source}）`, 'dsh 首次启动会自动创建；但如果这里应该是你原来的数据目录，说明路径指错了（设置里的 dshHome 与环境变量 DSH_HOME 会对调）')
    return
  }
  report.add('home', 'dsh-home', writableDir(home) ? 'ok' : 'warn', 'DSH_HOME', `${home}（来源：${ctx.dshHome.source}）`, writableDir(home) ? '' : 'dsh 要往这里写会话/存储；不可写会导致启动后各种报错')

  const credentialPath = join(home, '.credentials.yaml')
  if (isFile(credentialPath)) {
    report.add('home', 'credentials', 'info', '检测到 .credentials.yaml', '文件存在（内容不会被读取或打印）', '')
  }

  // 额外登记的 DSH_HOME
  if (ctx.dshHomes.length) {
    const lines = ctx.dshHomes.map((extra) => `${extra} → ${isDir(extra) ? '存在' : '不存在'}`)
    report.add('home', 'extra-homes', 'info', `另外登记了 ${ctx.dshHomes.length} 个 DSH_HOME`, lines.join('；'), '多环境调试用；只有在管理页顶部切换过去才会用到')
  }

  if (!ctx.profiles.length) {
    report.add('home', 'profiles', 'info', '还没有任何 profile', join(home, 'profiles'), 'dsh 首次启动会按模板初始化（web/bot 等）')
  } else {
    report.add('home', 'profiles', 'info', `已发现 ${ctx.profiles.length} 个 profile`, ctx.profiles.join('、'), '')
  }

  const profileDir = ctx.profileDir
  if (!isDir(profileDir)) {
    report.add(
      'home',
      'profile-dir',
      'info',
      `profile「${ctx.profile}」还没初始化`,
      profileDir,
      '模板 profile（web/headless/acp/sdk…）首次启动会自动初始化；自定义 profile 必须先有 package.json，否则 dsh 拒绝启动',
    )
    return
  }

  const packagePath = join(profileDir, 'package.json')
  if (isFile(packagePath)) {
    const text = readText(packagePath)
    try {
      JSON.parse(text)
    } catch {
      report.add('home', 'profile-package', 'warn', `profile「${ctx.profile}」的 package.json 解析失败`, packagePath, 'dsh 启动时读它，坏掉会直接起不来；从备份恢复或让管理页重装该 profile 的依赖')
    }
  } else {
    report.add('home', 'profile-package', 'info', `profile「${ctx.profile}」还没有 package.json`, profileDir, '自定义 profile 必须先有 package.json；模板 profile 首次启动会生成')
  }

  const nodeModules = join(profileDir, 'node_modules')
  if (!isDir(nodeModules)) {
    report.add('home', 'profile-deps', 'info', `profile「${ctx.profile}」还没装依赖`, nodeModules, '首次启动 dsh 会自己装；如果一直装不上，看日志里的 pnpm/store 相关报错')
  }

  const patchPath = join(profileDir, 'cordis.patch.yml')
  if (isFile(patchPath)) {
    const text = readText(patchPath)
    if (text === null) {
      report.add('home', 'profile-patch', 'warn', 'cordis.patch.yml 读不了', patchPath, '权限问题；dsh 会按空补丁启动，但你设置的插件开关可能失效')
    } else if (!looksLikeEntryList(text)) {
      report.add('home', 'profile-patch', 'warn', 'cordis.patch.yml 不是合法的条目列表', patchPath, 'dsh 只在顶层是「- id: …」条目列表时才认；手动编辑坏了会让整个补丁层失效，可在管理页恢复档里还原备份')
    } else {
      const disables = readPatchDisables(patchPath)
      report.add('home', 'profile-patch', 'info', 'cordis.patch.yml 顶层形状检查通过', `${patchPath}${disables.length ? `（${disables.length} 条禁用行）` : ''}；YAML 语法与字段有效性未验证`)
    }
  }

  const lockPath = join(profileDir, 'lock')
  if (isFile(lockPath)) {
    const pid = Number.parseInt(String(readText(lockPath) || '').trim(), 10)
    if (lockOwnerActive(lockPath)) {
      report.add('home', 'profile-lock', 'info', 'profile 正被占用', `${lockPath} · pid ${Number.isInteger(pid) ? pid : '?'} 还活着`, '正常：管理页正在装插件/改配置，或某个操作没结束。等它结束再操作这个 profile')
    } else {
      report.add('home', 'profile-lock', 'warn', '发现残留的 profile 锁', `${lockPath} · pid ${Number.isInteger(pid) ? pid : '?'} 已不存在`, `下次管理页改这个 profile 时会自动清理；如果提示「profile 锁被占用，稍后再试」而进程早没了，删掉这个 lock 文件再试`)
    }
  }

  const backups = listPatchBackups(profileDir)
  if (backups.length) {
    report.add('home', 'patch-backups', 'info', `profile 有 ${backups.length} 份补丁层备份`, backups.slice(0, 4).join('、') + (backups.length > 4 ? ' …' : ''), '「安全启动」或恢复时生成的；需要还原可在管理页插件页操作')
  }
}

/* ------------------------------------------------------------------ */
/* 检查：实例                                                          */
/* ------------------------------------------------------------------ */

function isUrlLike(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value)
}

function checkInstances(report, ctx) {
  if (!ctx.state) {
    if (ctx.manager) {
      report.add(
        'instance',
        'instances-unknown',
        'warn',
        '管理页在跑，但实例状态没查',
        `管理页 /api/state 读不到：${ctx.stateError || '未知原因'}`,
        '先看管理页日志/等它空闲；这期间别按「没有实例」处理，也别急着重启 dsh',
      )
    } else {
      report.add('instance', 'instances-unknown', 'info', '实例状态没查', '管理页没在跑，实例列表只有管理页才知道', '需要看实例状态就先启动管理页')
    }
    return
  }
  const instances = Array.isArray(ctx.state.instances) ? ctx.state.instances : []
  if (!instances.length) {
    report.add('instance', 'instances-empty', 'info', '当前没有 dsh 实例在跑', '', '需要用时在管理页点启动，或直接打开启动项')
  } else {
    const lines = instances.map((item) => {
      const url = isUrlLike(item.url) ? ` · ${oneLine(item.url, 90)}` : ''
      const started = ageText(item.startedAt)
      return `${item.version || '?'} · profile ${item.profile || '?'} · ${item.status || '?'}${started ? ` · ${started}启动` : ''}${url}`
    })
    report.add('instance', 'instances', 'ok', `${instances.length} 个实例在跑`, lines.join('；'))
  }

  const health = ctx.state.health
  if (health && typeof health === 'object') {
    const total = Number(health.total) || 0
    const ok = Number(health.ok) || 0
    const failed = Array.isArray(health.failed) ? health.failed : []
    const detail = `${health.version || '?'}${health.at ? ` · ${ageText(health.at)}` : ''} · ${ok}/${total} 个客户端插件包正常`
    if (failed.length) {
      report.add(
        'instance',
        'health',
        'warn',
        '上次页面自检有失败',
        detail,
        '页面能打开但部分插件面板/资源加载失败；看下面失败的 URL，必要时重装对应插件或还原补丁层',
        failed.slice(0, 4).map((item) => `HTTP ${item.status || '-'} ${oneLine(item.url || '', 160)}${item.error ? `（${oneLine(item.error, 80)}）` : ''}`),
      )
    } else if (total > 0) {
      report.add('instance', 'health', 'ok', '上次页面自检通过', detail)
    } else {
      report.add('instance', 'health', 'info', '上次页面自检没得出结论', detail, '一条客户端插件引用都没抓到，通常是 dsh 换了页面引用方式；不代表页面坏了')
    }
  } else {
    report.add('instance', 'health', 'info', '还没有页面自检结果', '实例启动成功并打开过页面后才会写', '')
  }

  const failure = ctx.state.failure
  if (failure && typeof failure === 'object') {
    const tail = Array.isArray(failure.tail) ? failure.tail.slice(-3) : []
    report.add(
      'instance',
      'failure',
      'fail',
      '上次启动失败',
      [
        failure.message ? oneLine(failure.message, 400) : '（没有错误信息）',
        `版本 ${failure.version || '?'} · profile ${failure.profile || '?'}${failure.at ? ` · ${ageText(failure.at)}` : ''}${failure.exit ? ` · 退出码 ${failure.exit}` : ''}`,
      ].join('；'),
      '按 tail 里的报错处理；常见是插件 import 失败、缺依赖、端口被占。管理页插件页可关插件，恢复档可整层撤补丁',
      tail.map((line) => oneLine(line, 300)),
    )
  } else {
    report.add('instance', 'failure', 'ok', '没有记录启动失败', '')
  }

  const autoFix = ctx.state.autoFix
  if (autoFix && typeof autoFix === 'object') {
    const plugins = Array.isArray(autoFix.plugins) ? autoFix.plugins : []
    report.add(
      'instance',
      'auto-fix',
      'warn',
      '上次启动按错误自动禁用了插件',
      `${autoFix.at ? ageText(autoFix.at) : ''}${autoFix.version ? ` · ${autoFix.version}` : ''} · ${plugins.map((item) => item.name || item.id).join('、') || '（记录为空）'}`,
      '自动禁用是为了先把 dsh 拉起来；确认插件问题后再回插件页启用，否则会一直是关着的',
    )
  }
}

/* ------------------------------------------------------------------ */
/* 检查：插件                                                          */
/* ------------------------------------------------------------------ */

function checkPlugins(report, ctx) {
  const payload = ctx.pluginsResult?.value
  if (!payload || typeof payload !== 'object') {
    const error = ctx.pluginsResult?.error
    if (ctx.manager) {
      report.add('plugin', 'plugins-unknown', 'warn', '管理页在跑，但插件清单没读到', error || '未知原因', '可能正忙/版本不匹配；重启管理页或稍后再跑')
    } else {
      report.add('plugin', 'plugins-unknown', 'info', '插件信息没查', '管理页没在跑，插件清单只有管理页才知道', '需要查插件就先启动管理页')
    }
    return
  }
  const profile = payload.profile || ctx.profile
  const plugins = Array.isArray(payload.plugins) ? payload.plugins : []
  const disables = Array.isArray(payload.disables) ? payload.disables : []
  if (!plugins.length) {
    report.add('plugin', 'plugins-empty', 'info', `profile「${profile}」没有第三方插件`, '（只剩官方组件）', '这是干净的初始状态；需要功能去插件页/整合包装')
  } else {
    report.add('plugin', 'plugins-count', 'ok', `profile「${profile}」的插件`, `已装 ${plugins.length} 个`)
  }

  const missing = plugins.filter((item) => !item.version)
  if (missing.length) {
    report.add(
      'plugin',
      'plugins-missing',
      'warn',
      `${missing.length} 个插件没装全`,
      missing.map((item) => item.name).join('、'),
      'node_modules 里没有这个包的 package.json；dsh 启动时 import 失败会带崩其它插件。在插件页重装这几个',
    )
  }

  const disabled = plugins.filter((item) => item.enabled === false)
  if (disabled.length) {
    const fixed = disabled.filter((item) => item.toggleable === false).map((item) => item.name)
    const toggleable = disabled.filter((item) => item.toggleable !== false).map((item) => item.name)
    const lines = []
    if (toggleable.length) lines.push(`可开关：${toggleable.join('、')}`)
    if (fixed.length) lines.push(`不可开关（官方/市场托管）：${fixed.join('、')}`)
    report.add(
      'plugin',
      'plugins-disabled',
      'info',
      `${disabled.length} 个插件被禁用`,
      lines.join('；'),
      toggleable.length ? '确认不用再关；需要的话在插件页打开（官方组件不建议关）' : '',
    )
  }

  if (payload.busy) {
    report.add('plugin', 'plugins-busy', 'info', '管理页正在修改插件', 'busy=true', '等操作结束再判断插件状态')
  }

  if (disables.length) {
    report.add(
      'plugin',
      'patch-disables',
      'info',
      `补丁层里有 ${disables.length} 条禁用行`,
      disables.join('、'),
      '这些行会让对应插件在 dsh 启动时被跳过；其中可能有已卸载插件的遗留行。确认没在用的清理掉，否则别人共用这份 profile 会莫名其妙少功能',
    )
  }

  const autoFix = payload.autoFix
  if (autoFix && typeof autoFix === 'object') {
    const list = Array.isArray(autoFix.plugins) ? autoFix.plugins : []
    report.add(
      'plugin',
      'plugins-autofix',
      'warn',
      '启动时自动禁用过插件（纠正后未复核）',
      `${autoFix.at ? ageText(autoFix.at) : ''} · ${list.map((item) => `${item.name || item.id}（${item.id || ''}）`).join('、') || '（记录为空）'}`,
      '自动禁用只解决「起不来」；插件本身的问题还在。确认包没坏后回插件页启用',
    )
  }

  const recovery = payload.recovery
  if (recovery && typeof recovery === 'object') {
    if (recovery.last) {
      const dropped = Array.isArray(recovery.last.dropped) ? recovery.last.dropped : []
      report.add(
        'plugin',
        'recovery-last',
        'info',
        '上次执行过「安全启动」',
        `${recovery.last.at ? ageText(recovery.last.at) : ''} · profile ${recovery.last.profile || '?'}${dropped.length ? ` · 摘掉 bundle：${dropped.join('、')}` : ''}${recovery.last.backup ? ` · 备份 ${oneLine(recovery.last.backup, 120)}` : ''}`,
        '安全启动会把补丁层整体移出、只留官方 bundle；要恢复插件配置用「还原」',
      )
    }
    const backups = Array.isArray(recovery.backups) ? recovery.backups : []
    if (backups.length) {
      report.add('plugin', 'recovery-backups', 'info', `profile 有 ${backups.length} 份补丁层备份`, backups.slice(0, 3).join('、'), '管理页插件页可一键还原最近一份')
    }
  }
}

/* ------------------------------------------------------------------ */
/* 检查：技能                                                          */
/* ------------------------------------------------------------------ */

function skillRoots(home) {
  const agentsHome = process.env.DSH_AGENTS_HOME ? resolve(process.env.DSH_AGENTS_HOME) : join(homedir(), '.agents')
  return [
    { key: 'dsh', dir: join(home, 'skills') },
    { key: 'agents', dir: join(agentsHome, 'skills') },
  ]
}

function locateFrontmatter(text) {
  const open = /^---[ \t]*\r?\n/.exec(text)
  if (!open) return null
  const rest = text.slice(open[0].length)
  const close = /^---[ \t]*(?:\r?\n|$)/m.exec(rest)
  if (!close) return null
  return { fmStart: open[0].length, fmEnd: open[0].length + close.index }
}

function parseFields(front) {
  const fields = {}
  let currentKey = ''
  const folded = []
  const flush = () => {
    if (currentKey && folded.length) fields[currentKey] = folded.join(' ').trim()
    currentKey = ''
    folded.length = 0
  }
  for (const line of front.split(/\r?\n/)) {
    const match = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(line)
    if (match) {
      flush()
      currentKey = match[1]
      const raw = match[2].trim()
      if (raw === '' || /^[|>][+-\d]*$/.test(raw)) continue
      fields[match[1]] = unquote(raw)
      currentKey = ''
    } else if (currentKey && /^\s+\S/.test(line)) {
      folded.push(line.trim())
    }
  }
  flush()
  return fields
}

function unquote(value) {
  const text = String(value ?? '').trim()
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1)
  }
  return text
}

/** 按 dsh-skill-filesystem 的规则说明这个技能为什么会被丢掉（空串 = 没问题）。 */
function describeFrontmatterIssue(file) {
  const text = readText(file)
  if (text === null) return '文件读不出来（权限？）'
  const fm = locateFrontmatter(text)
  if (!fm) return '没有 YAML frontmatter（首行必须是 ---，带 BOM 的文件 dsh 认不出来）'
  const fields = parseFields(text.slice(fm.fmStart, fm.fmEnd))
  const name = String(fields.name ?? '')
  if (!name) return 'frontmatter 缺 name'
  if (!KEBAB_NAME_RE.test(name)) return `name「${oneLine(name, 60)}」不是 kebab-case（只能小写字母、数字和连字符，如 my-skill）`
  if (!String(fields.description ?? '').trim()) return 'frontmatter 缺 description'
  for (const key of ['disable-model-invocation', 'user-invocable']) {
    const raw = fields[key]
    if (raw === undefined) continue
    const value = String(raw).toLowerCase()
    if (!BOOL_TRUE.has(value) && !BOOL_FALSE.has(value)) return `${key} 的值「${oneLine(raw, 40)}」不是合法布尔，dsh 会丢弃整个技能`
  }
  for (const legacy of LEGACY_FRONTMATTER_KEYS) {
    if (fields[legacy] !== undefined) return `${legacy} 是旧写法，dsh 会丢弃整个技能（要写 disable-model-invocation / user-invocable）`
  }
  return ''
}

function scanSkillRoot(root) {
  const out = { root, entries: [], emptyDirs: [], dangling: [] }
  let dirents = []
  try {
    dirents = readdirSync(root.dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of dirents) {
    // dsh 只跳过 dsh 根下的 .system；其它点开头条目照常发现，这里也照收
    if (entry.name === '.system' && root.key === 'dsh') continue
    const full = join(root.dir, entry.name)
    const followed = entry.isSymbolicLink() ? statOrNull(full) : null
    if (entry.isDirectory() || followed?.isDirectory() === true) {
      const file = join(full, 'SKILL.md')
      if (isFile(file)) out.entries.push({ rootKey: root.key, dirName: entry.name, kind: 'dir', linked: entry.isSymbolicLink(), file })
      else out.emptyDirs.push(`${root.key}/${entry.name}`)
    } else if ((entry.isFile() || followed?.isFile() === true) && /\.md$/i.test(entry.name)) {
      out.entries.push({ rootKey: root.key, dirName: entry.name.replace(/\.md$/i, ''), kind: 'flat', linked: entry.isSymbolicLink(), file: full })
    } else if (entry.isSymbolicLink() && !followed) {
      out.dangling.push(join(root.dir, entry.name))
    }
  }
  return out
}

function checkSkills(report, ctx) {
  const payload = ctx.skillsResult?.value
  if (ctx.opts.port && !Array.isArray(payload?.roots)) {
    report.add('skill', 'skill-roots', 'warn', '目标技能目录未核实', ctx.skillsResult?.error || '指定管理页未提供技能目录；未扫描当前终端的技能目录')
    return
  }
  const roots = ctx.opts.port ? payload.roots : payload?.roots?.length ? payload.roots : skillRoots(ctx.dshHome.dir)
  const scans = roots.map((root) => scanSkillRoot(root))

  const missingRoots = roots.filter((root) => !isDir(root.dir))
  if (missingRoots.length) {
    report.add(
      'skill',
      'skill-roots',
      'info',
      `${missingRoots.length} 个技能根还不存在`,
      missingRoots.map((root) => `${root.key}：${root.dir}`).join('；'),
      '还没有装技能时会这样；管理页技能页可以打开/创建',
    )
  }

  const emptyDirs = scans.flatMap((scan) => scan.emptyDirs)
  const dangling = scans.flatMap((scan) => scan.dangling)
  const scanned = scans.flatMap((scan) => scan.entries)

  if (dangling.length) {
    report.add(
      'skill',
      'skill-dangling',
      'warn',
      `有 ${dangling.length} 个技能链接断了`,
      dangling.slice(0, 6).join('、') + (dangling.length > 6 ? ' …' : ''),
      '指向的目标被删/移动了；删掉断链，或把目标恢复。dsh 会安静跳过它们，不报错',
    )
  }

  if (payload && Array.isArray(payload.skills)) {
    const skills = payload.skills
    if (!skills.length) {
      report.add('skill', 'skills-empty', 'info', '没有发现任何本地技能', '两个技能根都是空的', '用管理页技能页装，或把 SKILL.md 放进 ~/.dsh/skills/<名字>/')
    } else {
      report.add('skill', 'skills-count', 'ok', `${skills.length} 个技能可被 dsh 发现`, skills.map((item) => `${item.root}/${item.dirName}`).join('、'))
      const bad = skills.filter((item) => item.frontmatterOk === false)
      if (bad.length) {
        report.add(
          'skill',
          'skills-broken',
          'warn',
          `${bad.length} 个技能会被 dsh 丢掉`,
          bad.slice(0, 6).map((item) => `${item.root}/${item.dirName}：${oneLine(item.frontmatterIssue || 'frontmatter 不合法', 120)}`).join('；'),
          '按提示修 frontmatter（name 必须 kebab-case、description 非空、不能用驼峰开关）；不管的话它们不会出现在会话技能列表里',
        )
      }
      const byName = new Map()
      for (const skill of skills) {
        const key = skill.dirName.toLowerCase()
        const list = byName.get(key) || []
        list.push(skill)
        byName.set(key, list)
      }
      const shadows = [...byName.values()].filter((list) => list.length > 1)
      if (shadows.length) {
        report.add(
          'skill',
          'skills-shadowed',
          'info',
          `${shadows.length} 个技能名在多个根里重复`,
          shadows.map((list) => list.map((item) => `${item.root}/${item.dirName}`).join(' 与 ')).join('；'),
          'dsh 按技能根优先级选取，另一份不会生效；确认哪份是要用的',
        )
      }
      const selfSkill = skills.find((item) => item.dirName === 'dsh-x-selfcheck')
      if (!selfSkill) {
        report.add('skill', 'self-skill', 'info', '本自检技能不在技能根里', '脚本是从仓库直接跑，或技能还没安装', '安装入口见 SKILL.md；不影响脚本本身')
      } else {
        report.add('skill', 'self-skill', 'ok', '本自检技能已注册', `${selfSkill.root}/${selfSkill.dirName}${selfSkill.linked ? '（链接）' : ''}`)
      }
    }
    if (payload.localSkills && payload.localSkills.enabled === false) {
      report.add(
        'skill',
        'skills-local-disabled',
        'info',
        '本地技能行没有被强制启用',
        `补丁层里没有 skill-filesystem/tool-skill 的强制行（rows=${JSON.stringify(payload.localSkills.rows || [])}）`,
        'dsh 自己仍会扫技能根，链接/目录能出现在技能列表里就说明发现正常；只有「确实看不到某个本地技能」时，才去技能页打开「启用本地技能」',
      )
    }
  } else {
    // 管理页没跑：按与 skills.js 相同的规则自己判一遍
    const bad = []
    for (const entry of scanned) {
      const issue = describeFrontmatterIssue(entry.file)
      if (issue) bad.push(`${entry.rootKey}/${entry.dirName}：${issue}`)
    }
    if (!scanned.length) {
      report.add('skill', 'skills-empty', 'info', '没有发现任何本地技能', '两个技能根都没有 SKILL.md', '管理页没在跑，这里是按文件层扫的；装技能可用管理页')
    } else if (bad.length) {
      report.add('skill', 'skills-broken', 'warn', `${bad.length} 个技能会被 dsh 丢掉（按文件层判断）`, bad.slice(0, 6).join('；'), '按提示修 frontmatter；管理页在跑时用管理页看更准')
    } else {
      report.add('skill', 'skills-count', 'ok', `${scanned.length} 个技能可被 dsh 发现（按文件层判断）`, scanned.map((item) => `${item.rootKey}/${item.dirName}`).join('、'))
    }
  }

  if (emptyDirs.length) {
    report.add(
      'skill',
      'skills-empty-dirs',
      'info',
      `技能根下有 ${emptyDirs.length} 个目录没有 SKILL.md`,
      emptyDirs.slice(0, 8).join('、') + (emptyDirs.length > 8 ? ' …' : ''),
      '不是技能，dsh 不会加载；安装失败留下的空目录可以清掉，不影响功能',
    )
  }
}

/* ------------------------------------------------------------------ */
/* 检查：网络与同步                                                    */
/* ------------------------------------------------------------------ */

function checkNetworkConfig(report, ctx) {
  const settings = ctx.settings
  if (ctx.opts.port && !ctx.settingsResult?.value) {
    report.add('network', 'proxy', 'warn', '目标网络配置未核实', ctx.settingsResult?.error || '指定管理页未提供设置；不使用当前终端的网络配置')
  } else {
    const mode = String(settings.proxyMode || 'system')
    const lines = [`proxyMode=${mode}`, `downloadSource=${settings.downloadSource || 'mirror'}`, `updateSource=${settings.updateSource || 'mirror'}`]
    if (mode === 'manual') {
      if (!String(settings.proxyUrl || '').trim()) {
        report.add('network', 'proxy', 'warn', '手动代理模式但没填地址', lines.join(' · '), '管理页所有外网请求都会失败；填上形如 http://127.0.0.1:7890 的 http 代理，或把模式改成「跟随系统」')
      } else {
        lines.push(`proxyUrl=${oneLine(settings.proxyUrl, 120)}`)
        report.add('network', 'proxy', 'info', '网络代理配置', lines.join(' · '))
      }
    } else {
      report.add('network', 'proxy', 'info', '网络代理配置', lines.join(' · '), mode === 'off' ? '不走代理：直连 GitHub/npm 失败时就是这里' : '跟随系统代理；浏览器能上、启动器不能上时优先查这个')
    }
    if (settings.downloadSource === 'official' && mode === 'off') {
      report.add('network', 'proxy-guess', 'info', '官方源 + 不走代理', '国内直连 npmjs/github 经常超时', '装插件/更新失败时考虑切镜像源或开代理')
    }
  }

  // 同步：只取公开字段，绝不能把 s3/webdav 的密钥整段带出来
  const sync = ctx.syncResult?.value
  if (sync && typeof sync === 'object') {
    const missing = Array.isArray(sync.missing) ? sync.missing : []
    if (sync.configured === false) {
      report.add('network', 'sync', 'info', '云同步未配置', missing.length ? `还缺：${missing.join('、')}` : '', '不需要多机同步可以忽略；需要的话在管理页「同步」里填')
    } else if (missing.length) {
      report.add('network', 'sync', 'warn', '云同步配置不完整', `还缺：${missing.join('、')}`, '补全后才能在管理页测试/运行同步')
    } else if (sync.state && typeof sync.state === 'object' && sync.state.error) {
      report.add('network', 'sync', 'warn', '上次同步报错', oneLine(sync.state.error, 300), '看管理页同步页的错误详情；恢复网络或凭据后再跑一次')
    } else {
      report.add(
        'network',
        'sync',
        'ok',
        '云同步已配置',
        `${sync.store || '?'}${sync.remoteUrl ? ` · ${oneLine(sync.remoteUrl, 120)}` : ''}${sync.running ? ' · 正在同步' : ''}`,
      )
    }
  } else if (ctx.syncResult?.error) {
    report.add('network', 'sync', 'info', '同步配置没读到', ctx.syncResult.error, '不影响本地使用；要看同步就重启管理页再试')
  }
}

async function probeReach(url, timeout = 8000) {
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' })
    try {
      await res.body?.cancel()
    } catch {
      /* 已经读了也无所谓 */
    }
    return { ok: res.status < 500, status: res.status, ms: Date.now() - started }
  } catch (error) {
    return { ok: false, error: describeFetchError(error), ms: Date.now() - started }
  } finally {
    clearTimeout(timer)
  }
}

async function checkNetworkProbe(report, ctx) {
  if (ctx.manager) {
    // POST 不带 Origin：sameSiteRequest 对本机脚本直接放行
    const result = await requestJson(`${ctx.manager.base}/api/proxy/test`, { method: 'POST', timeout: 30000 })
    if (result.error) {
      report.add('network', 'net-probe', 'info', '网络自检没跑成', `调用 /api/proxy/test 失败：${result.error}`, '管理页在跑却调不通这个接口，可能是版本较旧；也可以看管理页「设置」里的网络自检按钮')
      return
    }
    const value = result.value || {}
    const detail = [
      value.url ? `地址 ${oneLine(value.url, 140)}` : '',
      value.via ? `方式 ${value.via}` : '',
      value.proxy ? `代理 ${oneLine(value.proxy, 120)}` : '',
      value.proxyError ? `代理报错 ${oneLine(value.proxyError, 200)}` : '',
      value.detail ? oneLine(value.detail, 200) : '',
    ].filter(Boolean).join(' · ')
    report.add(
      'network',
      'net-probe',
      value.ok ? 'ok' : 'warn',
      value.ok ? '外网自检通过' : '外网自检失败',
      detail || '（没有返回细节）',
      value.ok ? '' : '检查代理设置/下载源；直连失败多试镜像是国内常见情况（见管理页「设置 → 网络」）',
    )
    return
  }

  if (ctx.opts.port) {
    report.add('network', 'net-probe', 'warn', '目标网络探测未执行', '指定管理页未连接，不用当前终端的直连结果代替目标环境')
    return
  }

  // 管理页没跑：自己探两个最常见的地址，只说明「本机能不能出去」
  const targets = [
    { url: 'https://registry.npmmirror.com/-/ping', label: 'npm 镜像源' },
    { url: 'https://github.com', label: 'GitHub' },
  ]
  const lines = []
  let okCount = 0
  for (const target of targets) {
    const result = await probeReach(target.url)
    if (result.ok) okCount += 1
    lines.push(`${target.label}：${result.ok ? `可达（HTTP ${result.status}，${formatDuration(result.ms)}）` : `不可达（${result.error || `HTTP ${result.status}`}，${formatDuration(result.ms)}）`}`)
  }
  report.add(
    'network',
    'net-probe',
    okCount === targets.length ? 'ok' : okCount ? 'info' : 'warn',
    '外网连通性（脚本直连探测）',
    lines.join('；'),
    okCount ? '' : '管理页自己走的是 netFetch + 系统代理，和脚本直连不一定一样；以管理页的网络自检为准',
  )
}

/* ------------------------------------------------------------------ */
/* 检查：日志                                                          */
/* ------------------------------------------------------------------ */

const LOG_PATTERNS = [
  { key: 'startup-failure', label: '启动失败', severity: 'warn', test: (line) => /启动失败|安全启动失败/.test(line) },
  { key: 'plugin-import', label: '插件 import 失败', severity: 'warn', test: (line) => /failed to import loader entry/i.test(line) },
  { key: 'plugin-incompatible', label: '插件与 dsh 版本不兼容', severity: 'warn', test: (line) => /incompatible with dsh/i.test(line) },
  { key: 'module-missing', label: '找不到模块 / 目录链接异常', severity: 'warn', test: (line) => /Cannot find module|UNKNOWN: unknown error, readdir|-4094/i.test(line) },
  { key: 'page-selfcheck-failed', label: '页面自检失败', severity: 'warn', test: (line) => /页面自检：/.test(line) && !/全部正常/.test(line) && !/没得出结论/.test(line) },
  { key: 'auto-disable', label: '启动时自动禁用插件', severity: 'info', test: (line) => /\[兼容\].*自动禁用/.test(line) },
  { key: 'recovery', label: '执行过安全启动/还原', severity: 'info', test: (line) => /\[恢复\]/.test(line) },
  { key: 'port-busy', label: '端口被占用', severity: 'info', test: (line) => /EADDRINUSE|已被占用/.test(line) },
  { key: 'exit-code', label: '子进程非零退出', severity: 'info', test: (line) => { const m = /已退出 code=(-?\d+)/.exec(line); return Boolean(m) && Number(m[1]) !== 0 } },
  { key: 'deps-repair', label: '依赖修复 / store 不匹配', severity: 'info', test: (line) => /ERR_PNPM_UNEXPECTED_STORE|修复依赖|repair/i.test(line) },
]

const LOG_LINE_TIME_RE = /^\[(\d{4}-\d{2}-\d{2}T[^\]]+)\]/

function analyzeLogs(text) {
  const lines = String(text || '').split(/\r?\n/).filter((line) => line.trim())
  const tail = lines.slice(-LOG_TAIL_LINES)
  const findings = new Map()
  for (const line of tail) {
    const timeMatch = LOG_LINE_TIME_RE.exec(line)
    const at = timeMatch ? Date.parse(timeMatch[1]) : Number.NaN
    for (const pattern of LOG_PATTERNS) {
      if (!pattern.test(line)) continue
      const item = findings.get(pattern.key) || {
        key: pattern.key,
        label: pattern.label,
        severity: pattern.severity,
        count: 0,
        lastAt: Number.NaN,
        samples: [],
        packages: new Map(),
      }
      item.count += 1
      if (Number.isFinite(at) && (!Number.isFinite(item.lastAt) || at > item.lastAt)) item.lastAt = at
      // 版本不兼容的原文极长（peerDependencies 一大串），按包名聚合才有可读性
      if (pattern.key === 'plugin-incompatible') {
        const slug = /Plugin\s+(\S+)\s+is incompatible with dsh\s+([^\s:]+)/.exec(line)
        if (slug) {
          const known = item.packages.get(slug[1]) || { dshVersion: slug[2], count: 0, lastAt: Number.NaN }
          known.count += 1
          if (Number.isFinite(at) && (!Number.isFinite(known.lastAt) || at > known.lastAt)) known.lastAt = at
          item.packages.set(slug[1], known)
        }
      }
      // 样例留最后两条：旧日志开头的历史报错没有诊断价值
      if (item.samples[item.samples.length - 1] !== line) {
        item.samples.push(line)
        if (item.samples.length > 2) item.samples.shift()
      }
      findings.set(pattern.key, item)
    }
  }
  return { findings: [...findings.values()], lines: tail.length }
}

function checkLogs(report, ctx) {
  const logs = ctx.logs
  if (logs.skipped) {
    report.add('log', 'logs-skipped', 'info', '按参数跳过了日志分析', '（--no-logs）', '')
    return
  }
  if (!logs.text) {
    report.add('log', 'logs-missing', 'info', '没有读到日志', logs.error || 'manager.log 不存在', '管理页启动后才有日志；也可以直接看管理页的「日志」页')
    return
  }
  const { findings, lines } = analyzeLogs(logs.text)
  report.add('log', 'logs-source', 'info', '日志来源', `${logs.source} · 分析最后 ${lines} 行`, '')
  if (!findings.length) {
    report.add('log', 'logs-clean', 'ok', '最近日志没发现异常模式', `分析最后 ${lines} 行`, '')
    return
  }
  // 旧日志里的警告会一直留着；当前实例跑着、且该警告最后一次出现已超过 3 天，就按历史事件报，避免长期刷同一条噪声
  const instanceRunning = Array.isArray(ctx.state?.instances) && ctx.state.instances.some((item) => item.status === 'running')
  const staleMs = 3 * 24 * 60 * 60 * 1000
  for (const item of findings) {
    if (item.severity === 'warn' && instanceRunning && Number.isFinite(item.lastAt) && Date.now() - item.lastAt > staleMs) {
      item.severity = 'info'
      item.stale = true
    }
  }
  const warns = findings.filter((item) => item.severity === 'warn')
  const infos = findings.filter((item) => item.severity !== 'warn')
  for (const item of warns) {
    const hint =
      item.key === 'plugin-incompatible'
        ? '日志记录插件版本与 dsh 不兼容；核对本次实例的实际加载来源后，优先检查是否有支持当前 dsh 的插件升级。禁用或卸载需先核对依赖与影响范围并由用户确认，本自检不会执行修改'
        : '按报错修对应插件/依赖；实例还在跑的话不急着动，先看「实例」一节的启动失败记录'
    report.add('log', `log-${item.key}`, 'warn', `日志里有「${item.label}」（${item.count} 次）`, logFindingDetail(item), hint)
  }
  if (infos.length) {
    const detail = infos
      .map((item) => {
        const base = `${item.label} ×${item.count}`
        if (!item.stale) return base
        return `${base}（最近一次 ${ageText(item.lastAt)}，按历史事件处理）`
      })
      .join('、')
    report.add('log', 'log-history', 'info', `日志里还有 ${infos.length} 类历史事件`, detail, '多数是过去发生过的，实例现在跑着就不用处理')
  }
}

function logFindingDetail(item) {
  const parts = []
  if (item.packages?.size) {
    const packages = [...item.packages.entries()]
      .sort((a, b) => (b[1].lastAt || 0) - (a[1].lastAt || 0))
      .map(([name, info]) => {
        const last = Number.isFinite(info.lastAt) ? `，最近一次 ${ageText(info.lastAt)}` : ''
        return `${name}（对 dsh ${info.dshVersion}${last}）`
      })
    parts.push(`涉及 ${packages.slice(0, 4).join('、')}${packages.length > 4 ? ` 等 ${packages.length} 个包` : ''}`)
  }
  // 包名已经说清楚时不再贴 peerDependencies 原文，太长且对排障没帮助
  if (!item.packages?.size && item.samples.length) {
    parts.push(item.samples.map((line) => oneLine(line, 200)).join('；'))
  }
  return parts.join(' —— ')
}

/* ------------------------------------------------------------------ */
/* 人类可读报告                                                        */
/* ------------------------------------------------------------------ */

const STATUS_LABEL = { fail: 'FAIL', warn: 'WARN', info: '提示', ok: ' OK ' }
const STATUS_ORDER = ['fail', 'warn', 'info']

function wrapText(text, width) {
  const out = []
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    let line = rawLine
    while (line.length > width) {
      out.push(line.slice(0, width))
      line = line.slice(width)
    }
    out.push(line)
  }
  return out
}

function renderTarget(ctx) {
  const lines = []
  if (ctx.manager) {
    lines.push(`管理页  ${ctx.manager.base} · 启动器 v${ctx.manager.info.version || '未知'}`)
  } else {
    lines.push(`管理页  没找到（试过 ${ctx.portCandidates.map((port) => `127.0.0.1:${port}`).join('、')}）`)
  }
  if (ctx.installDir) lines.push(`安装目录 ${ctx.installDir}`)
  lines.push(`版本目录 ${ctx.dataDir.dir || '（未确定）'}${ctx.dataDir.dir ? `（${ctx.dataDir.source}）` : ''}`)
  lines.push(`DSH_HOME ${ctx.dshHome.dir}（${ctx.dshHome.source}） · profile ${ctx.profile}`)
  return lines
}

function renderHuman(result, ctx, opts) {
  const lines = []
  lines.push(`DSH-X 环境自检 · ${formatLocalTime(new Date(result.at))} · 用时 ${formatDuration(result.elapsedMs)}`)
  lines.push(`${result.platform.platform} ${result.platform.arch} · Node ${result.platform.node}`)
  lines.push(...renderTarget(ctx))
  lines.push('')

  const byStatus = (status) => result.checks.filter((check) => check.status === status)
  const renderCheck = (check) => {
    const title = `${STATUS_LABEL[check.status]} ${check.sectionLabel} · ${check.title}`
    lines.push(title)
    if (check.detail) {
      for (const line of wrapText(check.detail, 96)) lines.push(`        ${line}`)
    }
    for (const evidence of check.evidence) {
      for (const line of wrapText(evidence, 96)) lines.push(`        | ${line}`)
    }
    if (check.hint) {
      for (const line of wrapText(check.hint, 96)) lines.push(`        → ${line}`)
    }
  }

  for (const status of STATUS_ORDER) {
    const checks = byStatus(status)
    if (!checks.length) continue
    for (const check of checks) renderCheck(check)
  }
  const okChecks = byStatus('ok')
  if (opts.verbose) {
    for (const check of okChecks) renderCheck(check)
  } else if (okChecks.length) {
    lines.push(`${STATUS_LABEL.ok} ${okChecks.length} 项通过（加 --verbose 看明细）`)
  }

  lines.push('')
  lines.push(`结论：${summaryText(result.summary)}`)
  lines.push(`正常 ${result.summary.ok} · 提示 ${result.summary.info} · 警告 ${result.summary.warn} · 失败 ${result.summary.fail}`)
  lines.push(`退出码 ${result.summary.exitCode}（0 正常 / 1 有警告 / 2 有失败，3 是脚本自身出错）`)
  return lines.join('\n')
}

function summaryText(summary) {
  if (summary.verdict === 'problem') return '有失败项，按上面的 → 建议处理'
  if (summary.verdict === 'attention') return '有提示或警告，多数不影响使用；需要的话按 → 处理'
  return '正常'
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

function runCheck(report, section, label, fn, ctx) {
  try {
    return fn(report, ctx)
  } catch (error) {
    report.add(
      section,
      `error-${section}`,
      'warn',
      `「${label}」检查没跑成`,
      oneLine(error?.stack || error, 300),
      '这是脚本缺陷；把 --json 输出和这条一起反馈给维护者',
    )
    return undefined
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    process.stdout.write(`${usage()}\n`)
    return
  }
  const ctx = await buildContext(opts)
  const report = createReport()
  runCheck(report, 'environment', '环境', checkEnvironment, ctx)
  runCheck(report, 'manager', '管理页', checkManager, ctx)
  runCheck(report, 'data', '版本与数据', checkData, ctx)
  runCheck(report, 'home', 'DSH_HOME/profile', checkHome, ctx)
  runCheck(report, 'instance', '实例', checkInstances, ctx)
  runCheck(report, 'plugin', '插件', checkPlugins, ctx)
  runCheck(report, 'skill', '技能', checkSkills, ctx)
  runCheck(report, 'network', '网络与同步', checkNetworkConfig, ctx)
  runCheck(report, 'log', '日志', checkLogs, ctx)
  if (opts.net) {
    try {
      await checkNetworkProbe(report, ctx)
    } catch (error) {
      report.add('network', 'error-network', 'warn', '「外网探测」没跑成', oneLine(error?.message || error, 200), '网络依赖外部环境，失败不代表环境有问题')
    }
  }

  const summary = summarize(report)
  const result = {
    tool: TOOL,
    schema: SCHEMA_VERSION,
    version: TOOL_VERSION,
    at: new Date().toISOString(),
    elapsedMs: Date.now() - ctx.startedAt,
    platform: { platform: process.platform, arch: process.arch, node: process.versions.node },
    target: {
      managerUrl: ctx.manager ? ctx.manager.base : '',
      managerVersion: ctx.manager?.info?.version || '',
      managerFound: Boolean(ctx.manager),
      installDir: ctx.installDir || '',
      dataDir: ctx.dataDir.dir || '',
      dataDirSource: ctx.dataDir.source || '',
      dshHome: ctx.dshHome.dir,
      dshHomeSource: ctx.dshHome.source,
      profile: ctx.profile,
      logsSource: ctx.logs.skipped ? '' : ctx.logs.source,
    },
    checks: report.checks,
    summary,
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } else {
    process.stdout.write(`${renderHuman(result, ctx, opts)}\n`)
  }
  process.exitCode = summary.exitCode
}

// 作为命令跑才执行；被测试 import（拿 mask 做脱敏单测）时只暴露函数，不产生副作用。
// Node 的 ESM 入口按 realpath 解析：经 junction / symlink 安装时 argv[1] 还是链接路径，
// import.meta.url 却是真实路径，直接字符串比较会不相等，导致文档推荐的 junction 安装方式
// 静默不执行（exit 0、零输出）。所以两边都取 realpath，Windows 再忽略大小写。
function runningAsEntry() {
  const argvPath = process.argv[1]
  if (!argvPath) return false
  const real = realpathSync.native || realpathSync
  const normalize = (value) => (process.platform === 'win32' ? value.toLowerCase() : value)
  try {
    return normalize(real(resolve(argvPath))) === normalize(real(fileURLToPath(import.meta.url)))
  } catch {
    return false
  }
}
if (runningAsEntry()) {
  main().catch((error) => {
    process.stderr.write(`[${TOOL}] 脚本自身出错：${error?.stack || error}\n`)
    process.exitCode = 3
  })
}
