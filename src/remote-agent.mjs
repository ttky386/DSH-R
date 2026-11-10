import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { request } from 'node:http'
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, networkInterfaces, tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import { ensureBundleMounted, listPlugins, setPluginEnabled } from './plugins.js'
import { listMcpServers, probeMcpServer, removeMcpServer, saveMcpServer, setMcpEnabled } from './mcp.js'
import { createSkill, installSkillPackages, listSkills, localSkillsEnabled, removeSkill, rootDirOf, setLocalSkillsEnabled, setSkillEnabled, skillRoots } from './skills.js'
import {
  applyInstall,
  exportPack,
  forgetPack,
  parsePackArchive,
  planInstall,
  readPackState,
  rememberPack,
  uninstallPack,
} from './packs.js'

const HOME = homedir()
const ROOT = join(HOME, '.dsh-x-remote')
const RUNTIME = join(ROOT, 'runtime', 'node')
const NODE = join(RUNTIME, 'bin', 'node')
const NPM = join(RUNTIME, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
const VERSION_ROOT = join(ROOT, 'versions')
const FORWARD_FILE = join(ROOT, 'lib', 'remote-forward.mjs')
const STATE_ROOT = join(ROOT, 'state')
const LOG_ROOT = join(ROOT, 'logs')
const PROFILE_RE = /^[A-Za-z0-9._-]{1,32}$/
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._+-]*$/
const ID_RE = /^[a-f0-9]{16}$/
const READY_RE = /dsh web:\s+(https?:\/\/[^\s]+)/
const SENSITIVE_RE = /(token|secret|password|passwd|authorization|api[-_]?key|private[-_]?key|session[-_]?key)/i
const CREDENTIAL_REF_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
/** DSH 官方文件链路。探测只读磁盘事实；安装仍走 dsh plugin add，不绕开版本协商。 */
const FILE_PLUGINS = [
  { name: '@deepseek-ai/dsh-client-file-upload', capability: 'upload' },
  { name: '@deepseek-ai/dsh-api-workspace-files', capability: 'workspace' },
  { name: '@deepseek-ai/dsh-client-ui-sidebar-files', capability: 'tree' },
  { name: '@deepseek-ai/dsh-client-ui-sidebar-documentpreview', capability: 'preview' },
  { name: '@deepseek-ai/dsh-file-reference', capability: 'reference' },
]
const FILE_TEXT_MAX_BYTES = 2 * 1024 * 1024
const FILE_BINARY_MAX_BYTES = 16 * 1024 * 1024
const FILE_ENTRY_LIMIT = 1000
const MUTATING_OPERATIONS = new Set([
  'version-install', 'version-optimize', 'version-remove', 'version-replace',
  'profile-create', 'profile-rename', 'profile-delete',
  'profile-recover', 'profile-recover-restore', 'config-write',
  'credentials-set', 'credentials-unset',
  'plugin-toggle', 'plugin-install', 'plugin-update', 'plugin-remove', 'dependency-repair',
  'pack-install', 'pack-uninstall', 'pack-export',
  'mcp-save', 'mcp-toggle', 'mcp-remove',
  'skills-create', 'skills-install', 'skills-toggle', 'skills-remove', 'skills-local-toggle',
  // 文件面板第一阶段 deliberately read-only：list/read/capabilities 不在这里，
  // 后续加写入时必须继续走同一把互斥锁。
  'start', 'stop', 'pair-issue',
])

function out(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function fail(message, extra = {}) {
  process.stderr.write(`DSHX_AGENT_ERROR:${JSON.stringify({ message: String(message), ...extra })}\n`)
  process.exit(1)
}

function input() {
  const encoded = process.argv[3] === '--stdin' ? readFileSync(0, 'utf8').trim() : String(process.argv[3] || '')
  const raw = Buffer.from(encoded, 'base64').toString('utf8')
  try {
    return raw ? JSON.parse(raw) : {}
  } catch {
    fail('远端代理参数不是有效 JSON')
  }
}

function profileName(value) {
  const name = String(value ?? '')
  if (!PROFILE_RE.test(name) || name === '.' || name === '..' || name === 'node_modules') fail(`Profile 名不合法：${name}`)
  return name
}

function versionName(value) {
  const version = String(value ?? '')
  if (!VERSION_RE.test(version) || version === '.' || version === '..') fail(`版本号不合法：${version}`)
  return version
}

function launchId(value) {
  const id = String(value ?? '')
  if (!ID_RE.test(id)) fail('启动项 ID 不合法')
  return id
}

function dshHomeOf(value = '') {
  const home = String(value ?? '').trim() || join(HOME, '.dsh')
  if (!home.startsWith('/') || home.length > 4096 || /[\0\r\n]/.test(home)) fail('远端 DSH_HOME 必须是 Linux 绝对路径')
  return home
}

function inside(parent, child) {
  const left = resolve(parent)
  const right = resolve(child)
  return right === left || right.startsWith(`${left}${sep}`)
}

function safeProfileDir(payload, name) {
  const home = dshHomeOf(payload.dshHome)
  const dir = join(home, 'profiles', profileName(name))
  if (!inside(join(home, 'profiles'), dir)) fail('Profile 路径越界')
  return dir
}

/**
 * 远端文件面板的根 deliberately 是 DSH_HOME（不是 /）：用户目录已经是我们被授权
 * 管理的边界。绝对路径也收下，但 realpath 后必须仍在根内，项目内 .dsh 可直接填。
 */
function safeFileTarget(payload, { mustExist = true } = {}) {
  const root = dshHomeOf(payload.dshHome)
  const inputPath = String(payload.path ?? '.')
  if (inputPath.includes('\0') || inputPath.length > 4096) fail('远端文件路径不合法')
  const target = resolve(root, inputPath || '.')
  if (!inside(root, target)) fail('远端文件路径越界，已拒绝')
  if (!mustExist) return { root, target, relPath: relative(root, target) || '.' }
  let realRoot = root
  let realTarget = target
  try {
    realRoot = realpathSync(root)
    realTarget = realpathSync(target)
  } catch {
    fail('远端文件或目录不存在')
  }
  if (!inside(realRoot, realTarget)) fail('远端文件路径指向 DSH_HOME 外，已拒绝')
  return { root, target: realTarget, relPath: relative(root, realTarget) || '.' }
}

function fileStat(entry, parent, root) {
  const path = join(parent, entry.name)
  let size = 0
  let mtimeMs = 0
  try {
    const stat = statSync(path, { throwIfNoEntry: false })
    size = Number(stat?.size || 0)
    mtimeMs = Number(stat?.mtimeMs || 0)
  } catch {
    // 坏链接 / 权限异常仍显示一行，读取时再给出准确错误。
  }
  let type = entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'symlink' : 'other'
  let symlink = entry.isSymbolicLink()
  if (entry.isSymbolicLink()) {
    try {
      const real = realpathSync(path)
      if (!inside(realpathSync(root), real)) {
        type = 'symlink'
      } else {
        const target = statSync(real, { throwIfNoEntry: false })
        type = target?.isDirectory() ? 'directory' : target?.isFile() ? 'file' : 'symlink'
      }
    } catch {
      type = 'symlink'
    }
  }
  return { name: entry.name, path: relative(parent, path), type, symlink, size, mtimeMs }
}

function listRemoteFiles(payload) {
  const { root, target, relPath } = safeFileTarget(payload)
  const stat = lstatSync(target, { throwIfNoEntry: false })
  if (!stat?.isDirectory()) fail('远端路径不是目录')
  const entries = readdirSync(target, { withFileTypes: true })
    .map((entry) => fileStat(entry, target, root))
    .sort((left, right) => left.type === right.type
      ? left.name.localeCompare(right.name, undefined, { numeric: true })
      : left.type === 'directory' ? -1 : 1)
  return {
    ok: true,
    root,
    path: relPath,
    parent: relPath === '.' ? '' : relPath.split('/').slice(0, -1).join('/'),
    entries: entries.slice(0, FILE_ENTRY_LIMIT),
    truncated: entries.length > FILE_ENTRY_LIMIT,
    total: entries.length,
  }
}

function remoteFileMime(name) {
  const ext = name.toLowerCase().split('.').pop()
  return {
    txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown',
    json: 'application/json', yaml: 'text/yaml', yml: 'text/yaml',
    js: 'text/javascript', mjs: 'text/javascript', cjs: 'text/javascript',
    ts: 'text/typescript', css: 'text/css', html: 'text/html', htm: 'text/html',
    csv: 'text/csv', log: 'text/plain', py: 'text/x-python', sh: 'text/x-shellscript',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf',
  }[ext] || 'application/octet-stream'
}

function remoteFileTextKind(mime) {
  return mime.startsWith('text/') || /^(?:application\/json|image\/svg\+xml)$/.test(mime)
}

function readRemoteFile(payload) {
  const { root, target, relPath } = safeFileTarget(payload)
  const name = basename(target).toLowerCase()
  // SSH 用户当然能读这些文件；但 DSH-X 的预览面板不能变成凭据回显入口。
  if (name === '.credentials.yaml' || name === '.env'
    || /\.(?:pem|key|p12|pfx|kdbx)$/i.test(name) || SENSITIVE_RE.test(name)) {
    fail('这个远端文件可能包含凭据，禁止在预览面板读取', { code: 'REMOTE_FILE_SENSITIVE' })
  }
  const stat = statSync(target, { throwIfNoEntry: false })
  if (!stat?.isFile()) fail('远端路径不是普通文件')
  const mime = remoteFileMime(target)
  const wantText = payload.mode === 'text' || (payload.mode !== 'bytes' && remoteFileTextKind(mime))
  const limit = wantText ? FILE_TEXT_MAX_BYTES : FILE_BINARY_MAX_BYTES
  if (stat.size > limit) {
    fail(`远端文件超过预览上限（${Math.floor(limit / 1024 / 1024)}MB）：${relPath}`, { code: 'REMOTE_FILE_TOO_LARGE', size: stat.size, limit })
  }
  const bytes = readFileSync(target)
  // 未知扩展名按文本尝试；NUL 说明是二进制。已知文本类型不再扫描，避免对 UTF-8 内容做双重猜测。
  const text = wantText && (remoteFileTextKind(mime) || !bytes.includes(0)) ? bytes.toString('utf8') : ''
  const isText = wantText && Boolean(text)
  return {
    ok: true,
    root,
    path: relPath,
    size: stat.size,
    mtimeMs: Number(stat.mtimeMs || 0),
    mime: isText ? mime : remoteFileMime(target),
    kind: isText ? 'text' : 'bytes',
    ...(isText ? { text } : { base64: bytes.toString('base64') }),
  }
}

function installedFilePlugin(payload, spec, profileDir, installed) {
  const candidates = [
    join(profileDir, 'node_modules', spec.name),
    ...(installed ? [
      join(VERSION_ROOT, installed.version, 'node_modules', spec.name),
      join(VERSION_ROOT, installed.version, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', spec.name),
    ] : []),
  ]
  for (const [index, dir] of candidates.entries()) {
    const manifest = readJson(join(dir, 'package.json'), null)
    if (!manifest) continue
    return {
      name: spec.name,
      capability: spec.capability,
      installed: true,
      version: String(manifest.version || ''),
      source: index === 0 ? 'profile' : 'dsh',
    }
  }
  return { name: spec.name, capability: spec.capability, installed: false, version: '', source: '' }
}

function remoteFileCapabilities(payload) {
  const home = dshHomeOf(payload.dshHome)
  const profile = profileName(payload.profile || 'web')
  const profileDir = safeProfileDir({ ...payload, dshHome: home }, profile)
  const installed = installedVersions().find((item) => item.version === payload.version) || installedVersions().at(-1) || null
  const rows = listPlugins(profileDir).plugins
  const plugins = FILE_PLUGINS.map((spec) => {
    const row = installedFilePlugin(payload, spec, profileDir, installed)
    const declared = rows.find((item) => item.name === spec.name)
    return declared ? { ...row, enabled: declared.enabled !== false } : { ...row, enabled: row.installed }
  })
  const byCapability = (capability) => plugins.filter((item) => item.capability === capability).every((item) => item.installed && item.enabled !== false)
  const upload = byCapability('upload')
  const workspace = byCapability('workspace')
  const tree = workspace && byCapability('tree')
  const preview = workspace && byCapability('preview')
  return {
    ok: true,
    dshHome: home,
    profile,
    dshVersion: installed?.version || '',
    plugins,
    missing: plugins.filter((item) => !item.installed).map((item) => item.name),
    features: {
      upload,
      tree,
      preview,
      links: preview && byCapability('reference'),
    },
  }
}

function versionDir(version) {
  return join(VERSION_ROOT, versionName(version))
}

function currentVersion(payload) {
  if (payload.version && payload.version !== 'auto') return versionName(payload.version)
  const installed = installedVersions()
  return installed.at(-1)?.version || fail('远端还没有安装 DSH，先安装版本')
}

function pluginSpec(value) {
  const spec = String(value ?? '').trim()
  if (/^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+(?:@[a-z0-9._~+-]+)?$/i.test(spec)) return spec
  if (/^github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:#[\w./-]+)?$/.test(spec)) return spec
  if (/^file:\/[^\0]+$/.test(spec)) return spec
  fail('插件源不合法')
}

function packageName(value) {
  const name = String(value ?? '').trim()
  const match = /^(@[^/@]+\/[^/@]+|[^@/]+)$/.exec(name)
  if (!match) fail('插件包名不合法')
  return match[1]
}

function stateFile(id) {
  return join(STATE_ROOT, `${launchId(id)}.json`)
}

function logFile(id) {
  return join(LOG_ROOT, `${launchId(id)}.log`)
}

function ensureDirs() {
  for (const dir of [ROOT, VERSION_ROOT, STATE_ROOT, LOG_ROOT]) mkdirSync(dir, { recursive: true, mode: 0o700 })
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: options.timeout || 120_000,
    maxBuffer: 32 * 1024 * 1024,
    cwd: options.cwd,
    env: {
      ...process.env,
      ...(options.env || {}),
      DSH_HOME: options.dshHome ?? process.env.DSH_HOME ?? join(HOME, '.dsh'),
    },
  })
  if (result.error) fail(result.error.message, { code: result.error.code })
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim()
  if (result.status !== 0) fail(output || `${basename(command)} 退出码 ${result.status}`, { code: 'REMOTE_COMMAND_FAILED', status: result.status })
  return result
}

function nodeVersion() {
  if (!existsSync(NODE)) return ''
  const result = spawnSync(NODE, ['--version'], { encoding: 'utf8', timeout: 10_000 })
  return result.status === 0 ? String(result.stdout || '').trim() : ''
}

function installedVersions() {
  try {
    return readdirSync(VERSION_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => {
        const manifest = readJson(join(VERSION_ROOT, entry.name, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), {})
        return { version: entry.name, packageVersion: manifest.version || '', valid: VERSION_RE.test(entry.name) }
      })
      .filter((item) => item.valid)
      .sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }))
  } catch {
    return []
  }
}

function listProfiles(home) {
  const root = join(home, 'profiles')
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
      .map((entry) => {
        const dir = join(root, entry.name)
        const manifestFile = join(dir, 'package.json')
        const manifest = readJson(manifestFile, null)
        const bundles = Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []
        return {
          name: entry.name,
          initialized: Boolean(manifest),
          symlink: entry.isSymbolicLink(),
          bundles,
          dependencies: Object.keys(manifest?.dependencies || {}),
          running: profileProcesses(home, entry.name).length > 0,
        }
      })
      .filter((item) => item.initialized)
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
}

function procInfo(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ')
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean)
    const env = Object.fromEntries(readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean).map((line) => {
      const at = line.indexOf('=')
      return at > 0 ? [line.slice(0, at), line.slice(at + 1)] : [line, '']
    }))
    let cwd = ''
    try { cwd = realpathSync(`/proc/${pid}/cwd`) } catch {}
    return { pid: Number(pid), ppid: Number(stat[3]), command: cmdline.join(' '), cwd, env, starttime: stat[21] }
  } catch {
    return null
  }
}

function profileProcesses(home, profile) {
  const wantedHome = resolve(home)
  const processes = []
  for (const entry of readdirSync('/proc', { withFileTypes: true })) {
    if (!/^\d+$/.test(entry.name)) continue
    const info = procInfo(entry.name)
    if (!info || info.pid === process.pid) continue
    if (resolve(info.env.DSH_HOME || join(HOME, '.dsh')) !== wantedHome) continue
    const words = info.command.split(' ')
    const isDsh = info.command.includes('@deepseek-ai/dsh/lib/bin.js')
      || (/(^|\/)dsh(\s|$)/.test(info.command) && words.includes(profile))
    if (!isDsh || !words.includes(profile)) continue
    processes.push({ pid: info.pid, command: info.command, cwd: info.cwd, starttime: info.starttime })
  }
  return processes
}

function allDshProcesses() {
  const processes = []
  for (const entry of readdirSync('/proc', { withFileTypes: true })) {
    if (!/^\d+$/.test(entry.name)) continue
    const info = procInfo(entry.name)
    if (info && info.command.includes('@deepseek-ai/dsh/lib/bin.js')) {
      processes.push({ pid: info.pid, command: info.command, cwd: info.cwd, starttime: info.starttime, env: info.env })
    }
  }
  return processes
}

function stateAlive(state) {
  if (!state?.pid) return false
  const info = procInfo(state.pid)
  return Boolean(info && String(info.starttime) === String(state.starttime))
}

function forwarderAlive(state) {
  if (!state?.forwarderPid) return false
  const info = procInfo(state.forwarderPid)
  return Boolean(info && String(info.starttime) === String(state.forwarderStarttime) && info.command.includes('remote-forward.mjs'))
}

async function stopForwarder(state) {
  if (!forwarderAlive(state)) return
  try { process.kill(state.forwarderPid, 'SIGTERM') } catch {}
  const deadline = Date.now() + 3000
  while (Date.now() < deadline && forwarderAlive(state)) await sleep(0.1)
  if (forwarderAlive(state)) {
    try { process.kill(state.forwarderPid, 'SIGKILL') } catch {}
  }
}

function processTreePids(root) {
  const children = new Map()
  let rootSeen = false
  for (const entry of readdirSync('/proc', { withFileTypes: true })) {
    if (!/^\d+$/.test(entry.name)) continue
    const info = procInfo(entry.name)
    if (!info) continue
    if (info.pid === root) rootSeen = true
    const parent = Number(info.ppid || 0)
    if (!children.has(parent)) children.set(parent, [])
    children.get(parent).push(info.pid)
  }
  if (!rootSeen) return []
  const out = []
  const queue = [root]
  while (queue.length) {
    const pid = queue.shift()
    if (out.includes(pid)) continue
    out.push(pid)
    queue.push(...(children.get(pid) || []))
  }
  return out.reverse()
 }

function readState(id) {
  const state = readJson(stateFile(id))
  if (!state) fail('远端没有这个启动项的运行记录')
  return state
}

function writeState(id, state) {
  writeJson(stateFile(id), state)
}

function tail(file, lines = 160) {
  try {
    return readFileSync(file, 'utf8').split(/\r?\n/).slice(-lines)
  } catch {
    return []
  }
}

function listenerPorts(pid) {
  const result = spawnSync('ss', ['-ltnp'], { encoding: 'utf8', timeout: 5000 })
  if (result.status !== 0) return []
  return String(result.stdout || '').split(/\r?\n/).filter((line) => line.includes(`pid=${pid},`)).map((line) => {
    const local = /\s(\S+?):(\d+)\s/.exec(line)
    return local ? { bind: local[1], port: Number(local[2]) } : null
  }).filter(Boolean)
}

function publicState(state) {
  const ports = []
  const seen = new Set()
  const collect = (pid) => {
    for (const item of listenerPorts(pid)) {
      const key = JSON.stringify(item)
      if (seen.has(key)) continue
      seen.add(key)
      ports.push(item)
    }
  }
  if (stateAlive(state)) collect(state.pid)
  if (forwarderAlive(state)) collect(state.forwarderPid)
  return {
    ...state,
    alive: stateAlive(state),
    forwarderAlive: forwarderAlive(state),
    ports,
    log: tail(state.logPath || logFile(state.id)),
  }
}

async function probeState(state) {
  if (!stateAlive(state)) return { ok: false, status: 0, reason: 'process-not-running' }
  const ports = listenerPorts(state.pid)
  if (!ports.length) return { ok: false, status: 0, reason: 'listener-not-found' }
  if (!state.url) return { ok: false, status: 0, reason: 'url-missing' }
  try {
    const response = await fetch(state.url, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
    // 启动 token 首跳是 303；已带 cookie 时可能是 200。401 说明服务在但 token/cookie 不适用。
    return {
      ok: response.status === 200 || response.status === 303,
      status: response.status,
      reason: response.status === 401 ? 'authentication-required' : '',
    }
  } catch (error) {
    return { ok: false, status: 0, reason: error?.cause?.code || error?.code || 'fetch-failed' }
  }
}

async function waitUntilHttpReady(state, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  let probe = { ok: false, status: 0, reason: 'not-probed' }
  while (Date.now() < deadline && stateAlive(state)) {
    probe = await probeState(state)
    if (probe.ok) return probe
    await sleep(0.25)
  }
  return stateAlive(state)
    ? probe
    : { ...probe, ok: false, reason: probe.reason || 'process-not-running' }
}

/**
 * DSH 官方 remote-web-ui 的配对发币接口只信任远端本机回环来源。
 * DSH-X 通过 SSH 在远端本机发起请求，并把 Host 也写成回环；源地址保持 127.0.0.1。
 * 返回的一次性配对 URL 只通过 SSH/本机管理接口交给当前内部标签页，不写日志。
 */
function loopbackPairRequest(state, path, method = 'GET', payload = null) {
  return new Promise((resolve, reject) => {
    const body = payload === null ? '' : JSON.stringify(payload)
    const headers = {
      host: `127.0.0.1:${state.port}`,
      connection: 'close',
      ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}),
    }
    const req = request({
      host: state.effectiveHost || state.publicHost,
      port: state.port,
      localAddress: '127.0.0.1',
      method,
      path,
      headers,
      timeout: 8000,
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (res.statusCode !== 200) {
          const error = new Error(`远端 DSH 配对接口返回 ${res.statusCode}`)
          error.statusCode = res.statusCode
          error.body = text.slice(0, 512)
          reject(error)
          return
        }
        try { resolve(JSON.parse(text)) } catch (error) { reject(error) }
      })
    })
    req.on('timeout', () => req.destroy(new Error('远端 DSH 配对接口超时')))
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

async function pairStatus(payload) {
  const state = readJson(stateFile(payload.id))
  if (!stateAlive(state)) fail('远端 DSH 尚未运行，无法读取配对状态')
  try {
    return await loopbackPairRequest(state, '/api/pair/status')
  } catch (error) {
    if (error.statusCode === 404) fail('远端 DSH 未启用 remote-web-ui 配对插件', { code: 'REMOTE_PAIR_PLUGIN_UNAVAILABLE' })
    if (error.statusCode === 403) fail('远端 DSH 配对接口拒绝 DSH-X 的本机受信请求', { code: 'REMOTE_PAIR_FORBIDDEN' })
    fail(error.message, { code: 'REMOTE_PAIR_STATUS_FAILED' })
  }
}

async function pairIssue(payload) {
  const state = readJson(stateFile(payload.id))
  if (!stateAlive(state)) fail('远端 DSH 尚未运行，无法生成配对链接')
  const address = String(payload.address || state.publicHost || state.effectiveHost || '')
  try {
    const issued = await loopbackPairRequest(state, '/api/pair/issue', 'POST', {})
    // Tailscale/CGNAT 地址会被 remote-web-ui 的“局域网候选”过滤掉；DSH-X 的私有转发器
    // 让该地址实际可达，并已写入 trustedHosts。这里只改 base，不改官方一次性 token。
    if (address && issued.url) {
      const url = new URL(issued.url)
      url.hostname = address
      issued.url = url.toString()
    }
    return issued
  } catch (error) {
    if (error.statusCode === 400) fail(`远端 DSH 不认识配对地址 ${address}`, { code: 'REMOTE_PAIR_ADDRESS_UNKNOWN' })
    if (error.statusCode === 403) fail('远端 DSH 配对接口拒绝 DSH-X 的本机受信请求', { code: 'REMOTE_PAIR_FORBIDDEN' })
    if (error.statusCode === 409) fail('远端 DSH 当前绑定不可生成配对链接', { code: 'REMOTE_PAIR_LAN_REQUIRED' })
    fail(error.message, { code: 'REMOTE_PAIR_ISSUE_FAILED' })
  }
}

function packageSkeleton(name) {
  return {
    name: `dsh-profile-${name}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], patchReload: 'live' } },
  }
}

function ensureProfile(home, name) {
  if (['web', 'headless', 'acp', 'sdk', 'sdk-minimal'].includes(name.toLowerCase())) return
  const dir = safeProfileDir({ dshHome: home }, name)
  if (existsSync(dir)) return
  mkdirSync(dirname(dir), { recursive: true, mode: 0o700 })
  mkdirSync(dir, { mode: 0o700 })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(packageSkeleton(name), null, 2)}\n`, { mode: 0o600 })
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n', { mode: 0o600 })
  writeFileSync(join(dir, 'cordis.patch.yml'), '[]\n', { mode: 0o600 })
}

function ensureRemoteReverseForwardPatch(home, profile) {
  const dir = safeProfileDir({ dshHome: home }, profile)
  if (!existsSync(join(dir, 'node_modules', '@linxin666', 'dsh-remote-web-ui', 'package.json'))) return false
  const plugins = Array.isArray(listPlugins(dir)?.plugins) ? listPlugins(dir).plugins : []
  const row = plugins.find((item) => String(item.name || '').includes('dsh-remote-web-ui') || String(item.name || '').includes('dsh-web-all'))
  const id = row?.ids?.find((value) => String(value).includes('remote-web-ui')) || 'remote-web-ui'
  const file = join(dir, 'cordis.patch.yml')
  const marker = '# DSH-X remote reverse forward'
  let text = existsSync(file) ? readFileSync(file, 'utf8') : '[]\n'
  for (const old of ['# DSH-X remote LAN forwarder', '# DSH-X remote VPN forward', '# DSH-X direct trusted host', marker]) {
    text = text.split(`\n${old}\n`)[0]
  }
  // reverse-forward 会让插件在内层看到 127.0.0.1。配对插件不能再把请求改写到
  // /remote：其规则表不知道 dsh-market、task-board、agents 等第三方根路径。
  text += `\n${marker}\n- id: ${id}\n  config:\n    requirePairingForLan: false\n    lanBind: false\n`
  writeFileSync(file, `${text}\n`, { mode: 0o600 })
  return true
}

function dshEntry(version) {
  const entry = join(versionDir(version), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!existsSync(entry)) fail(`远端 DSH ${version} 未安装或入口缺失`)
  return entry
}

function runDsh(version, args, payload) {
  const home = dshHomeOf(payload.dshHome)
  return run(NODE, [dshEntry(version), ...args], {
    cwd: home,
    dshHome: home,
    timeout: 1_800_000,
    env: { PATH: `${dirname(NODE)}:${process.env.PATH || ''}` },
  })
}

function npmEnv(payload) {
  return {
    PATH: `${dirname(NODE)}:${process.env.PATH || ''}`,
    npm_config_registry: String(payload.registry || 'https://registry.npmmirror.com').replace(/\/$/, ''),
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    npm_config_progress: 'false',
  }
}

function installVersion(payload) {
  const version = versionName(payload.version)
  const target = versionDir(version)
  if (existsSync(target)) return { ok: true, version, installed: true }
  mkdirSync(VERSION_ROOT, { recursive: true, mode: 0o700 })
  const staging = mkdtempSync(join(VERSION_ROOT, '.stage-'))
  try {
    writeFileSync(join(staging, 'package.json'), `${JSON.stringify({ name: 'dsh-remote-version', private: true, version: '0.0.0' }, null, 2)}\n`)
    run(NODE, [NPM, 'install', `@deepseek-ai/dsh@${version}`, '--omit=dev', '--no-audit', '--no-fund'], {
      cwd: staging, timeout: 1_800_000, env: npmEnv(payload),
    })
    const manifest = readJson(join(staging, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
    if (manifest?.version !== version) fail(`远端安装结果不是 DSH ${version}`)
    renameSync(staging, target)
    return { ok: true, version, installed: true }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

function removeVersion(payload) {
  const version = versionName(payload.version)
  const dir = versionDir(version)
  if (!inside(VERSION_ROOT, dir) || !existsSync(dir)) fail(`远端 DSH ${version} 未安装`)
  for (const file of readdirSync(STATE_ROOT)) {
    const state = readJson(join(STATE_ROOT, file))
    if (state?.version === version && stateAlive(state)) fail(`DSH ${version} 正在运行，先停止再删除`)
  }
  if (allDshProcesses().some((item) => item.command.includes(dir))) fail('外部 DSH 正在使用这个版本，先停止它再删除')
  rmSync(dir, { recursive: true, force: true })
  return { ok: true, version, removed: true }
}

function normalizeUrl(url, publicHost, bind, loopbackForward = false) {
  const parsed = new URL(url)
  if (publicHost && (loopbackForward || bind === '0.0.0.0' || parsed.hostname === '0.0.0.0')) parsed.hostname = publicHost
  return parsed.toString()
}

function concreteBindHost(bind, publicHost) {
  if (bind !== '0.0.0.0') return bind
  const addresses = []
  for (const interfaces of Object.values(networkInterfaces())) {
    for (const item of interfaces || []) {
      if ((item.family === 4 || item.family === 'IPv4') && !item.internal) addresses.push(item.address)
    }
  }
  // DSH 官方 CLI 拒绝 wildcard。设置仍保存 0.0.0.0；实际启动选择控制端要访问的那个
  // 具体 IPv4（优先 VPN 地址），避免改官方源码或退回 127.0.0.1。
  if (publicHost && addresses.includes(publicHost)) return publicHost
  return addresses.find((address) => /^100\.(6[4-9]|[7-9]\d?|1[01]\d|12[0-7])\./.test(address))
    || addresses.find((address) => /^192\.168\./.test(address))
    || addresses.find((address) => /^10\./.test(address))
    || addresses.find((address) => /^172\.(1[6-9]|2\d|3[01])\./.test(address))
    || addresses[0]
    || fail('远端没有可绑定的具体 IPv4；DSH 官方拒绝 0.0.0.0 wildcard')
}

async function sleep(seconds) {
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
}

async function start(payload) {
  const id = launchId(payload.id)
  const version = versionName(payload.version)
  const profile = profileName(payload.profile || 'web')
  const home = dshHomeOf(payload.dshHome)
  const bind = String(payload.bind || '0.0.0.0')
  if (!/^(?:0\.0\.0\.0|127\.0\.0\.1|(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3})$/.test(bind)) fail('远端绑定地址不合法')
  const port = Number(payload.port || 0)
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail('端口不合法')
  const old = readJson(stateFile(id))
  if (old && stateAlive(old)) {
    // 外部接管的进程没有我们的启动 token，不能因为 URL 未知判定启动失败；
    // 受管实例则等 HTTP 首跳真的 200/303 后才把“已启动”交给内部标签页。
    const probe = old.managed === false ? await probeState(old) : await waitUntilHttpReady(old)
    if (old.managed !== false && !probe.ok) {
      fail(`远端 DSH 进程在运行，但 HTTP 服务检测失败：${probe.reason || probe.status || '未知原因'}`, { code: 'REMOTE_DSH_HTTP_NOT_READY', state: publicState(old), probe })
    }
    return {
      ...publicState(old),
      alreadyRunning: true,
      probe,
      warning: old.managed === false && !probe.ok ? '已接管外部 DSH 进程，但它的访问 token 未知，DSH-X 只能管理进程状态' : '',
    }
  }
  const external = profileProcesses(home, profile)
  if (external.length && payload.takeover !== true) {
    fail(`检测到远端已有 DSH profile「${profile}」进程，需要确认接管`, { code: 'REMOTE_DSH_TAKEOVER_REQUIRED', processes: external })
  }
  if (payload.takeover === true && external.length) {
    const proc = external[0]
    const now = Date.now()
    const state = {
      id, profile, home, bind, port: 0, pid: proc.pid, pgid: 0, starttime: proc.starttime,
      managed: false, version: 'external', startedAt: now, logPath: '', publicHost: payload.publicHost || '', command: proc.command,
    }
    writeState(id, state)
    const probe = await probeState(state)
    return {
      ...publicState(state),
      takeover: true,
      url: '',
      probe,
      warning: probe.ok ? '' : '已接管外部 DSH 进程，但它的访问 token 未知，DSH-X 只能管理进程状态',
    }
  }
  // 官方 DSH 拒绝 wildcard。DSH-X 远程模式改为：DSH 本体只监听远端回环；
  // 私有 reverse-forward 监听 VPN/局域网地址并把 Host/Origin 改写成回环。
  const forwardHost = bind === '0.0.0.0' && payload.publicHost ? payload.publicHost : ''
  const effectiveHost = forwardHost ? '127.0.0.1' : concreteBindHost(bind, payload.publicHost)
  const args = [dshEntry(version), profile, '--host', effectiveHost]
  ensureProfile(home, profile)
  if (forwardHost) {
    ensureRemoteReverseForwardPatch(home, profile)
  }
  mkdirSync(LOG_ROOT, { recursive: true, mode: 0o700 })
  const log = logFile(id)
  // 每次自己的受管启动重开日志；追加模式会把上一次的 ready URL 先读回来，
  // 导致已经停止的旧端口被当成这次实例的访问地址。
  const fd = openSync(log, 'w', 0o600)
  // 0 也要显式传：不传时官方 CLI 落到自己的默认端口；--port 0 才会让系统挑空闲端口。
  args.push('--port', String(port))
  args.push('--no-open')
  const child = spawn(NODE, args, {
    cwd: home,
    detached: true,
    env: { ...process.env, DSH_HOME: home, PATH: `${dirname(NODE)}:${process.env.PATH || ''}`, ELECTRON_RUN_AS_NODE: '' },
    stdio: ['ignore', fd, fd],
  })
  child.unref()
  closeSync(fd)
  const info = procInfo(child.pid)
  const state = {
    id, version, profile, home, bind, effectiveHost, port, pid: child.pid, pgid: child.pid,
    starttime: info?.starttime, managed: true, startedAt: Date.now(), logPath: log,
    publicHost: payload.publicHost || '', command: info?.command || args.join(' '),
  }
  writeState(id, state)
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline && stateAlive(state)) {
    const match = READY_RE.exec(tail(log, 80).join('\n'))
    if (match) {
      state.url = normalizeUrl(match[1], payload.publicHost, bind)
      state.port = Number(new URL(state.url).port) || state.port
      if (forwardHost) {
        const forwarder = spawn(NODE, [FORWARD_FILE, forwardHost, String(state.port), '127.0.0.1', String(state.port)], {
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, PATH: `${dirname(NODE)}:${process.env.PATH || ''}` },
        })
        forwarder.unref()
        const forwarderInfo = procInfo(forwarder.pid)
        state.forwarderPid = forwarder.pid
        state.forwarderStarttime = forwarderInfo?.starttime
        state.forwarderHost = forwardHost
        await sleep(0.2)
      }
      writeState(id, state)
      const probe = await waitUntilHttpReady(state)
      if (!stateAlive(state)) fail(`DSH 启动失败：${tail(log, 30).join('\n')}`, { code: 'REMOTE_DSH_START_FAILED', state: publicState(state), probe })
      if (!probe.ok) {
        const message = `DSH 已输出地址但 HTTP 服务未就绪（${probe.reason || probe.status || '未知原因'}），已停止这次启动`
        await stop({ id })
        fail(message, { code: 'REMOTE_DSH_HTTP_NOT_READY', state: publicState(state), probe })
      }
      return {
        ...publicState(state),
        url: state.url,
        probe,
        warning: bind === '127.0.0.1'
          ? '远端绑定 127.0.0.1，Windows 无法直接访问这个地址'
          : bind === '0.0.0.0' ? `DSH 官方拒绝 wildcard；DSH 绑定 127.0.0.1，由远端转发器监听 ${forwardHost}` : '',
      }
    }
    await sleep(0.2)
  }
  const alive = stateAlive(state)
  fail(alive ? 'DSH 已启动但 120 秒内没有输出访问地址' : `DSH 启动失败：${tail(log, 30).join('\n')}`, { code: alive ? 'REMOTE_DSH_NO_URL' : 'REMOTE_DSH_START_FAILED', state: publicState(state) })
}

async function stop(payload) {
  const id = launchId(payload.id)
  const state = readJson(stateFile(id))
  if (!state) return { id, alive: false, stopped: false, reason: 'no-record', ports: [], log: [] }
  if (!stateAlive(state)) {
    await stopForwarder(state)
    return { ...publicState(state), stopped: false, reason: 'not-running' }
  }
  const targets = processTreePids(state.pid)
  if (!targets.length) fail(`PID ${state.pid} 已不存在或无法确认身份，拒绝按名字匹配`)
  for (const pid of targets) {
    try { process.kill(pid, 'SIGTERM') } catch (error) { fail(`停止 PID ${pid} 失败：${error.message}`) }
  }
  const deadline = Date.now() + 12_000
  while (Date.now() < deadline && stateAlive(state)) await sleep(0.2)
  if (stateAlive(state)) {
    for (const pid of processTreePids(state.pid)) {
      try { process.kill(pid, 'SIGKILL') } catch {}
    }
    const killDeadline = Date.now() + 3000
    while (Date.now() < killDeadline && stateAlive(state)) await sleep(0.1)
  }
  if (stateAlive(state)) fail(`PID ${state.pid} 拒绝退出，未执行任何按进程名匹配的删除操作`)
  await stopForwarder(state)
  state.stoppedAt = Date.now()
  writeState(id, state)
  return { ...publicState(state), stopped: true }
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact)
  if (!value || typeof value !== 'object') return value
  const outValue = {}
  for (const [key, item] of Object.entries(value)) {
    outValue[key] = SENSITIVE_RE.test(key) && typeof item === 'string' && item ? '__DSHX_REDACTED__' : redact(item)
  }
  return outValue
}

function restoreRedacted(next, old) {
  if (Array.isArray(next)) return next.map((item, index) => restoreRedacted(item, old?.[index]))
  if (!next || typeof next !== 'object' || !old || typeof old !== 'object') return next
  for (const [key, oldItem] of Object.entries(old)) {
    if (!SENSITIVE_RE.test(key) || typeof oldItem !== 'string') continue
    if (next[key] === '__DSHX_REDACTED__') next[key] = oldItem
  }
  for (const [key, item] of Object.entries(next)) next[key] = restoreRedacted(item, old[key])
  return next
}

function backup(file) {
  if (!existsSync(file)) return ''
  const target = join(dirname(file), `.dshx-backup-${basename(file)}.${Date.now()}.${randomBytes(4).toString('hex')}`)
  writeFileSync(target, readFileSync(file), { mode: 0o600 })
  return target
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return error?.code === 'EPERM' }
}

/** 每次 SSH 都是独立 agent 进程；修改操作用远端文件锁互斥，避免两个窗口同时写同一 Profile。 */
function acquireMutationLock() {
  const lockRoot = join(ROOT, 'locks')
  const lockDir = join(lockRoot, 'mutation')
  mkdirSync(lockRoot, { recursive: true, mode: 0o700 })
  try {
    mkdirSync(lockDir)
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    const info = readJson(join(lockDir, 'owner.json'))
    const age = Date.now() - (statSync(lockDir).mtimeMs || 0)
    if (info?.pid && processExists(Number(info.pid))) fail(`远端另一个管理操作正在运行（PID ${info.pid}），请稍后再试`, { code: 'REMOTE_OPERATION_BUSY' })
    if (!info?.pid && age < 300_000) fail('远端管理操作锁正在初始化，请稍后再试', { code: 'REMOTE_OPERATION_BUSY' })
    // 持锁 agent 已退出时才能回收；超过 5 分钟没有 owner 的锁也视为中断遗留。
    rmSync(lockDir, { recursive: true, force: true })
    try { mkdirSync(lockDir) } catch (retryError) { fail(`无法获取远端管理操作锁：${retryError?.message || retryError}`, { code: 'REMOTE_OPERATION_BUSY' }) }
  }
  writeJson(join(lockDir, 'owner.json'), { pid: process.pid, startedAt: Date.now() })
  let released = false
  const release = () => {
    if (released) return
    released = true
    try { rmSync(lockDir, { recursive: true, force: true }) } catch {}
  }
  process.once('exit', release)
  return release
}

function recoveryBackups(profileDir) {
  try {
    return readdirSync(profileDir)
      .filter((name) => /^\.dshx-recovery-\d+-[a-f0-9]{8}$/.test(name) && statSync(join(profileDir, name), { throwIfNoEntry: false })?.isDirectory())
      .sort()
      .reverse()
  } catch {
    return []
  }
}

function configPath(payload) {
  const name = String(payload.file || '')
  if (!['package.json', 'cordis.patch.yml', 'cordis.yml'].includes(name)) fail('只支持编辑 package.json、cordis.patch.yml、cordis.yml')
  return join(safeProfileDir(payload, payload.profile), name)
}

function credentialsPath(payload) {
  return join(dshHomeOf(payload.dshHome), '.credentials.yaml')
}

function credentialRef(value) {
  const name = String(value ?? '').trim()
  if (!CREDENTIAL_REF_RE.test(name) || name.length > 128) fail('凭据名只能是 1-128 位的字母、数字、下划线，且以字母或下划线开头')
  return name
}

function assertCredentialFileSafety(file) {
  let info
  try { info = lstatSync(file, { throwIfNoEntry: false }) } catch { info = null }
  if (!info) return { exists: false, modeOk: true }
  if (info.isSymbolicLink()) fail('远端凭据文件是符号链接，拒绝读写')
  if (!info.isFile()) fail('远端凭据文件不是普通文件')
  const modeOk = (info.mode & 0o077) === 0
  if (!modeOk) fail('远端凭据文件权限过宽（group/other 不可读写），请先执行 chmod 600')
  return { exists: true, modeOk }
}

function listCredentialFacts(file) {
  const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const lines = text.split(/\r?\n/)
  const refs = []
  const records = []
  let section = ''
  let recordKey = ''
  for (const line of lines) {
    if (/^version:/.test(line)) continue
    const top = /^([A-Za-z_][A-Za-z0-9_]*):(?:\s|$)/.exec(line)
    if (top) {
      section = top[1]
      recordKey = ''
      continue
    }
    if (section === 'refs') {
      const match = /^ {2}([A-Za-z_][A-Za-z0-9_]*):\s*(\S.*)?$/.exec(line)
      if (match && String(match[2] || '').trim()) refs.push({ name: match[1], source: 'stored', writable: true })
    } else if (section === 'records') {
      const key = /^ {2}([^#:\s][^:]*):\s*(?:.*)?$/.exec(line)
      if (key) {
        recordKey = key[1].trim()
        records.push({ key: recordKey, kind: '' })
        continue
      }
      const kind = /^ {4}kind:\s*(\S.*)$/.exec(line)
      if (kind && recordKey) {
        const found = records.find((item) => item.key === recordKey)
        if (found) found.kind = kind[1].trim().replace(/^['"]|['"]$/g, '')
      }
    }
  }
  if (!refs.some((item) => item.name === 'DEEPSEEK_API_KEY')) refs.unshift({ name: 'DEEPSEEK_API_KEY', source: '', writable: true })
  return { version: /^version:\s*1\s*$/m.test(text) ? 1 : 0, refs, records }
}

function patchCredentialRef(text, name, value) {
  const lines = String(text ?? '').split(/\r?\n/)
  if (text && !/^version:\s*1\s*$/m.test(text)) fail('远端凭据文件版本不支持，拒绝修改')
  let refsAt = lines.findIndex((line) => /^refs:\s*$/.test(line))
  if (refsAt < 0) {
    const versionAt = lines.findIndex((line) => /^version:\s*1\s*$/.test(line))
    refsAt = versionAt + 1
    lines.splice(refsAt, 0, 'refs:')
  }
  let end = lines.length
  for (let index = refsAt + 1; index < lines.length; index += 1) {
    if (/^[A-Za-z_][A-Za-z0-9_]*:/.test(lines[index])) {
      end = index
      break
    }
  }
  const keyRe = new RegExp(`^( {2,})${name}:(?:.*)$`)
  const found = lines.slice(refsAt + 1, end).findIndex((line) => keyRe.test(line))
  if (value === undefined) {
    if (found >= 0) lines.splice(refsAt + 1 + found, 1)
    if (found >= 0) {
      let sectionEnd = lines.length
      for (let index = refsAt + 1; index < lines.length; index += 1) {
        if (/^[A-Za-z_][A-Za-z0-9_]*:/.test(lines[index])) {
          sectionEnd = index
          break
        }
      }
      // 新增后马上删除要回到原格式：refs 里已经没有条目时，标头也不能留下。
      if (!lines.slice(refsAt + 1, sectionEnd).some((line) => line.trim())) lines.splice(refsAt, 1)
    }
  } else if (found >= 0) {
    const match = keyRe.exec(lines[refsAt + 1 + found])
    lines[refsAt + 1 + found] = `${match[1]}${name}: ${JSON.stringify(value)}`
  } else {
    const first = lines.slice(refsAt + 1, end).find((line) => /^\s+\S/.test(line))
    const indent = first ? /^(\s+)/.exec(first)[1] : '  '
    const insertAt = end
    lines.splice(insertAt, 0, `${indent}${name}: ${JSON.stringify(value)}`)
  }
  let next = lines.join('\n')
  if (!next.endsWith('\n')) next += '\n'
  return next
}

async function dispatchMain() {
  ensureDirs()
  const payload = input()
  const operation = String(process.argv[2] || '')
  switch (operation) {
    case 'facts':
      out({
        ok: true, host: { home: HOME, platform: process.platform, arch: process.arch, node: process.version },
        agent: { root: ROOT, node: nodeVersion() },
        dshHome: dshHomeOf(payload.dshHome), profiles: listProfiles(dshHomeOf(payload.dshHome)),
        versions: installedVersions(), operations: ['facts', 'version-list', 'version-install', 'version-optimize', 'version-remove', 'version-replace', 'profile-list', 'profile-create', 'profile-rename', 'profile-delete', 'profile-recover', 'profile-recover-list', 'profile-recover-restore', 'config-read', 'config-write', 'credentials-list', 'credentials-set', 'credentials-unset', 'plugin-list', 'plugin-toggle', 'plugin-install', 'plugin-update', 'plugin-remove', 'dependency-check', 'dependency-repair', 'pack-list', 'pack-install', 'pack-uninstall', 'pack-export', 'mcp-list', 'mcp-save', 'mcp-toggle', 'mcp-remove', 'mcp-probe', 'skills-list', 'skills-detail', 'skills-create', 'skills-install', 'skills-toggle', 'skills-remove', 'skills-local-toggle', 'file-capabilities', 'file-list', 'file-read', 'state', 'start', 'stop'],
      })
      break
    case 'version-list': {
      const result = run(NODE, [NPM, 'view', '@deepseek-ai/dsh', 'versions', 'dist-tags', '--json'], { cwd: ROOT, timeout: 30_000, env: npmEnv(payload) })
      const metadata = JSON.parse(result.stdout || '{}')
      out({
        ok: true,
        installed: installedVersions(),
        tags: metadata['dist-tags'] || {},
        versions: Array.isArray(metadata.versions) ? metadata.versions : [],
      })
      break
    }
    case 'version-install': out(installVersion(payload)); break
    case 'version-optimize': {
      const version = versionName(payload.version)
      const dir = versionDir(version)
      if (!inside(VERSION_ROOT, dir) || !existsSync(dir)) fail(`远端 DSH ${version} 未安装`)
      if (profileProcesses(dshHomeOf(payload.dshHome), profileName(payload.profile || 'web')).some((item) => item.command.includes(dir))) fail('远端 DSH 正在运行，先停止再优化依赖')
      run(NODE, [NPM, 'dedupe', '--offline', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', '--package-lock=false', '--no-progress'], {
        cwd: dir, timeout: 1_800_000, env: npmEnv(payload),
      })
      if (!existsSync(dshEntry(version))) fail('优化后找不到 DSH 官方入口')
      out({ ok: true, version })
      break
    }
    case 'version-remove': out(removeVersion(payload)); break
    case 'version-replace': {
      removeVersion(payload)
      out(installVersion(payload))
      break
    }
    case 'profile-list': out({ ok: true, dshHome: dshHomeOf(payload.dshHome), profiles: listProfiles(dshHomeOf(payload.dshHome)) }); break
    case 'profile-create': {
      const name = profileName(payload.profile)
      const dir = safeProfileDir(payload, name)
      if (existsSync(dir)) fail(`Profile ${name} 已存在`)
      ensureProfile(dshHomeOf(payload.dshHome), name)
      out({ ok: true, profile: name, path: dir })
      break
    }
    case 'profile-rename': {
      const from = profileName(payload.from), name = profileName(payload.to)
      const home = dshHomeOf(payload.dshHome)
      if (['web', 'headless', 'acp', 'sdk', 'sdk-minimal'].includes(name.toLowerCase())) fail('这个名称是系统模板 Profile，不能作为重命名目标')
      if (profileProcesses(home, from).length) fail('Profile 正在运行，先停止再重命名')
      const source = safeProfileDir(payload, from), target = safeProfileDir({ ...payload }, name)
      if (existsSync(target)) fail(`Profile ${name} 已存在`)
      const manifest = readJson(join(source, 'package.json'))
      if (!manifest) fail('只能重命名已初始化的 Profile')
      if (lstatSync(source).isSymbolicLink()) fail('远端 Profile 是链接，拒绝重命名')
      renameSync(source, target)
      manifest.name = `dsh-profile-${name}`
      writeFileSync(join(target, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
      out({ ok: true, profile: name, path: target })
      break
    }
    case 'profile-delete': {
      const name = profileName(payload.profile)
      const home = dshHomeOf(payload.dshHome)
      const dir = safeProfileDir(payload, name)
      if (String(payload.confirmPath || '') !== dir) fail('删除确认路径与远端实际路径不一致，已拒绝')
      if (!inside(home, dir) || !existsSync(dir)) fail('Profile 不存在')
      let stat
      try { stat = lstatSync(dir, { throwIfNoEntry: false }) } catch { stat = null }
      if (!stat?.isDirectory() || stat.isSymbolicLink()) fail('远端 Profile 是链接或类型异常，拒绝删除')
      if (profileProcesses(home, name).length) fail('Profile 正在运行，先停止再删除')
      rmSync(dir, { recursive: true, force: true })
      out({ ok: true, deleted: dir })
      break
    }
    case 'config-read': {
      const file = configPath(payload)
      if (!existsSync(file)) fail('配置文件不存在')
      const text = readFileSync(file, 'utf8')
      if (file.endsWith('.json')) out({ ok: true, file: basename(file), content: JSON.stringify(redact(JSON.parse(text)), null, 2) })
      else out({ ok: true, file: basename(file), content: text.replace(/(^|\n)(\s*(?:token|secret|password|authorization|api[-_]?key)[^\n:]*)\s*:\s*([^\n]+)/gi, '$1$2: __DSHX_REDACTED__') })
      break
    }
    case 'config-write': {
      const file = configPath(payload)
      const content = String(payload.content || '')
      if (content.length > 2 * 1024 * 1024) fail('远端配置文件内容超过 2MB，拒绝保存')
      if (content.includes('__DSHX_REDACTED__') && file.endsWith('.yml')) fail('补丁配置仍包含脱敏占位符；请先从远端复制真实值或清空整个字段')
      if (!existsSync(file)) fail('配置文件不存在')
      const backupPath = backup(file)
      if (file.endsWith('.json')) {
        const next = JSON.parse(content)
        const old = readJson(file, {})
        restoreRedacted(next, old)
        writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
      } else {
        writeFileSync(file, content, { mode: 0o600 })
      }
      out({ ok: true, backup: backupPath })
      break
    }
    case 'file-capabilities': out(remoteFileCapabilities(payload)); break
    case 'file-list': out(listRemoteFiles(payload)); break
    case 'file-read': out(readRemoteFile(payload)); break
    case 'credentials-list': {
      const file = credentialsPath(payload)
      const safety = assertCredentialFileSafety(file)
      out({ ok: true, file, exists: safety.exists, permissionOk: safety.modeOk, ...listCredentialFacts(file) })
      break
    }
    case 'credentials-set':
    case 'credentials-unset': {
      const file = credentialsPath(payload)
      assertCredentialFileSafety(file)
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      const name = credentialRef(payload.name)
      const value = operation.endsWith('-set') ? String(payload.value ?? '') : undefined
      if (value !== undefined) {
        if (!value || value.length > 16384 || /[\0\r\n]/.test(value)) fail('凭据值不能为空、不能包含换行，且不超过 16KB')
        if (value.includes('__DSHX_REDACTED__')) fail('不能把脱敏占位符保存为真实凭据')
      }
      const installed = installedVersions()
      const version = payload.version && payload.version !== 'auto' ? versionName(payload.version) : installed.at(-1)?.version || ''
      let write
      if (version) {
        const atomic = await import(pathToFileURL(join(VERSION_ROOT, version, 'node_modules', '@deepseek-ai', 'dsh-atomic-write', 'lib', 'index.js')))
        write = async () => atomic.withFileLock(file, async () => {
          const current = existsSync(file) ? readFileSync(file, 'utf8') : 'version: 1\nrefs:\n'
          await atomic.writeFileAtomic(file, patchCredentialRef(current, name, value), { mode: 0o600, dirMode: 0o700 })
        }, { waitMs: 30_000 })
      } else {
        write = async () => {
          const current = existsSync(file) ? readFileSync(file, 'utf8') : 'version: 1\nrefs:\n'
          const next = patchCredentialRef(current, name, value)
          const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
          writeFileSync(temporary, next, { mode: 0o600 })
          renameSync(temporary, file)
        }
      }
      await write()
      assertCredentialFileSafety(file)
      out({ ok: true, name, set: value !== undefined, ...listCredentialFacts(file) })
      break
    }
    case 'profile-recover': {
      const dir = safeProfileDir(payload, payload.profile)
      const patchPath = join(dir, 'cordis.patch.yml')
      const backups = recoveryBackups(dir)
      const manifestFile = join(dir, 'package.json')
      const manifest = readJson(manifestFile)
      if (!manifest) fail('Profile 尚未初始化，不能安全修复')
      const backupName = `.dshx-recovery-${Date.now()}-${randomBytes(4).toString('hex')}`
      const backupDir = join(dir, backupName)
      mkdirSync(backupDir, { mode: 0o700 })
      writeFileSync(join(backupDir, 'package.json'), readFileSync(manifestFile), { mode: 0o600 })
      if (existsSync(patchPath)) writeFileSync(join(backupDir, 'cordis.patch.yml'), readFileSync(patchPath), { mode: 0o600 })
      const bundles = Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []
      const official = bundles.filter((name) => String(name).startsWith('@deepseek-ai/'))
      const dropped = bundles.filter((name) => !official.includes(name))
      manifest.dsh.profile.bundles = official
      writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
      writeFileSync(patchPath, '[]\n', { mode: 0o600 })
      out({ ok: true, dropped, backup: backupName, previous: backups[0] || '' })
      break
    }
    case 'profile-recover-list': {
      out({ ok: true, backups: recoveryBackups(safeProfileDir(payload, payload.profile)) })
      break
    }
    case 'profile-recover-restore': {
      const dir = safeProfileDir(payload, payload.profile)
      const backups = new Set(recoveryBackups(dir))
      const name = String(payload.backup || '')
      if (!backups.has(name)) fail('远端没有这个恢复备份')
      const backupDir = join(dir, name)
      writeFileSync(join(dir, 'package.json'), readFileSync(join(backupDir, 'package.json')), { mode: 0o600 })
      const patchBackup = join(backupDir, 'cordis.patch.yml')
      if (existsSync(patchBackup)) writeFileSync(join(dir, 'cordis.patch.yml'), readFileSync(patchBackup), { mode: 0o600 })
      else if (existsSync(join(dir, 'cordis.patch.yml'))) rmSync(join(dir, 'cordis.patch.yml'), { force: true })
      out({ ok: true, restored: name, backups: recoveryBackups(dir) })
      break
    }
    case 'plugin-list': {
      const dir = safeProfileDir(payload, payload.profile)
      out({ ok: true, ...listPlugins(dir), dshHome: dshHomeOf(payload.dshHome), profile: profileName(payload.profile) })
      break
    }
    case 'plugin-toggle': {
      const dir = safeProfileDir(payload, payload.profile)
      const result = setPluginEnabled(dir, packageName(payload.name), payload.enabled !== false)
      out({ ok: true, ...result, ...listPlugins(dir) })
      break
    }
    case 'plugin-install': {
      const spec = pluginSpec(payload.spec)
      const profile = profileName(payload.profile)
      runDsh(currentVersion(payload), ['plugin', '--profile', profile, 'add', spec], payload)
      const dir = safeProfileDir(payload, profile)
      ensureBundleMounted(dir, spec)
      out({ ok: true, ...listPlugins(dir) })
      break
    }
    case 'plugin-remove': {
      const name = packageName(payload.name)
      const profile = profileName(payload.profile)
      runDsh(currentVersion(payload), ['plugin', '--profile', profile, 'remove', name], payload)
      out({ ok: true, ...listPlugins(safeProfileDir(payload, profile)) })
      break
    }
    case 'plugin-update': {
      const profile = profileName(payload.profile)
      const name = payload.all === true ? '' : packageName(payload.name)
      runDsh(currentVersion(payload), ['plugin', '--profile', profile, 'update', ...(name ? [name] : [])], payload)
      out({ ok: true, ...listPlugins(safeProfileDir(payload, profile)) })
      break
    }
    case 'dependency-check':
    case 'dependency-repair': {
      const profile = profileName(payload.profile)
      const dir = safeProfileDir(payload, profile)
      const manifest = readJson(join(dir, 'package.json'), {})
      const dependencies = Object.keys(manifest?.dependencies || {})
      const missing = dependencies.filter((name) => !existsSync(join(dir, 'node_modules', name, 'package.json')))
      if (operation === 'dependency-repair') runDsh(currentVersion(payload), ['plugin', '--profile', profile, 'install'], payload)
      out({ ok: true, profile, dependencies, missing: operation === 'dependency-repair' ? [] : missing, repaired: operation === 'dependency-repair' })
      break
    }
    case 'pack-list': {
      const records = readPackState(ROOT).packs.filter((item) => !payload.profile || item.profile === payload.profile)
      out({ ok: true, packs: records, dataDir: ROOT })
      break
    }
    case 'pack-install': {
      const home = dshHomeOf(payload.dshHome)
      const profile = profileName(payload.profile)
      const rawBytes = payload.bytes
      const bytes = Buffer.isBuffer(rawBytes) ? rawBytes
        : Array.isArray(rawBytes?.data) ? Buffer.from(rawBytes.data)
          : Buffer.from(String(rawBytes || ''), 'base64')
      if (!bytes.length) fail('远端整合包内容为空')
      const pack = parsePackArchive(bytes)
      const plan = planInstall(pack, { home, profile, hostProfile: String(payload.hostProfile || '') })
      if (!plan.ok) fail(`远端整合包不能安装：${(plan.errors || []).join('；')}`)
      const records = readPackState(ROOT).packs.filter((item) => item.profile === plan.profile)
      const previous = records.find((item) => item.name === pack.fields.name && item.profile === plan.profile) || null
      if (previous && previous !== records.at(-1)) fail('这个远端整合包后面还安装了其他包，请先撤销后续安装再重装')
      const result = await applyInstall(plan, {
        home,
        dataDir: ROOT,
        pack,
        source: payload.source || '',
        previousRecord: previous,
        runInstall: async (targetProfile) => runDsh(currentVersion(payload), ['plugin', '--profile', targetProfile, 'install'], payload),
      })
      rememberPack(ROOT, result.record)
      out({ ok: true, ...result, packs: readPackState(ROOT).packs })
      break
    }
    case 'pack-uninstall': {
      const home = dshHomeOf(payload.dshHome)
      const record = readPackState(ROOT).packs.find((item) => item.name === payload.name && item.profile === profileName(payload.profile))
      if (!record) fail('远端没有这个整合包安装记录')
      const result = uninstallPack(record, { home })
      forgetPack(ROOT, record.name, record.profile)
      out({ ok: true, ...result, packs: readPackState(ROOT).packs })
      break
    }
    case 'pack-export': {
      const home = dshHomeOf(payload.dshHome)
      const result = exportPack({
        profileDir: safeProfileDir(payload, payload.profile),
        home,
        name: payload.name,
        version: payload.version,
        displayName: payload.displayName,
        description: payload.description,
        author: payload.author,
        includeHome: payload.includeHome === true,
      })
      out({ ok: true, name: result.name, version: result.version, profile: result.profile, entries: result.entries, base64: result.buffer.toString('base64') })
      break
    }
    case 'mcp-list': {
      const dir = safeProfileDir(payload, payload.profile)
      out({ ok: true, servers: listMcpServers(join(dir, 'cordis.patch.yml')), profile: profileName(payload.profile) })
      break
    }
    case 'mcp-probe': {
      const dir = safeProfileDir(payload, payload.profile)
      const list = listMcpServers(join(dir, 'cordis.patch.yml'))
      const servers = Array.isArray(list.servers) ? list.servers : []
      const results = []
      for (const server of servers.filter((item) => !item.broken && !item.disabled)) {
        results.push(await probeMcpServer(server, { timeoutMs: Number(payload.timeoutMs) || undefined, fetcher: globalThis.fetch?.bind(globalThis) }))
      }
      out({ ok: true, results, servers: list })
      break
    }
    case 'mcp-save': {
      const dir = safeProfileDir(payload, payload.profile)
      out({ ok: true, ...saveMcpServer(join(dir, 'cordis.patch.yml'), payload.spec || {}), ...listMcpServers(join(dir, 'cordis.patch.yml')) })
      break
    }
    case 'mcp-toggle': {
      const dir = safeProfileDir(payload, payload.profile)
      out({ ok: true, ...setMcpEnabled(join(dir, 'cordis.patch.yml'), payload.name, payload.enabled !== false), ...listMcpServers(join(dir, 'cordis.patch.yml')) })
      break
    }
    case 'mcp-remove': {
      const dir = safeProfileDir(payload, payload.profile)
      out({ ok: true, ...removeMcpServer(join(dir, 'cordis.patch.yml'), payload.name), ...listMcpServers(join(dir, 'cordis.patch.yml')) })
      break
    }
    case 'skills-list': {
      const home = dshHomeOf(payload.dshHome)
      const roots = skillRoots(home)
      out({ ok: true, roots: roots.map(({ key, dir }) => ({ key, dir })), skills: listSkills(roots), localEnabled: localSkillsEnabled(safeProfileDir(payload, payload.profile || 'web')) })
      break
    }
    case 'skills-detail': {
      const roots = skillRoots(dshHomeOf(payload.dshHome))
      const dir = rootDirOf(roots, payload.root || 'dsh')
      const skill = listSkills(roots).find((item) => item.root === (payload.root || 'dsh') && item.relPath === payload.relPath)
      if (!skill) fail('远端技能不存在')
      out({ ok: true, ...skill, content: readFileSync(join(dir, payload.relPath), 'utf8') })
      break
    }
    case 'skills-install': {
      const roots = skillRoots(dshHomeOf(payload.dshHome))
      const packages = (payload.packages || []).map((item) => ({
        ...item,
        files: (item.files || []).map((file) => ({
          ...file,
          data: Buffer.isBuffer(file.data) ? file.data
            : Array.isArray(file.data?.data) ? Buffer.from(file.data.data)
              : Buffer.from(String(file.data || ''), 'base64'),
        })),
      }))
      out({ ok: true, ...installSkillPackages(rootDirOf(roots, payload.root || 'dsh'), packages, payload.selected || []) })
      break
    }
    case 'skills-create': {
      const roots = skillRoots(dshHomeOf(payload.dshHome))
      out({ ok: true, ...createSkill(rootDirOf(roots, payload.root || 'dsh'), payload) })
      break
    }
    case 'skills-toggle': {
      const roots = skillRoots(dshHomeOf(payload.dshHome))
      out({ ok: true, ...setSkillEnabled(rootDirOf(roots, payload.root || 'dsh'), payload.relPath, payload.enabled !== false) })
      break
    }
    case 'skills-remove': {
      const roots = skillRoots(dshHomeOf(payload.dshHome))
      out({ ok: true, ...removeSkill(rootDirOf(roots, payload.root || 'dsh'), payload.relPath) })
      break
    }
    case 'skills-local-toggle': {
      out({ ok: true, ...setLocalSkillsEnabled(safeProfileDir(payload, payload.profile), payload.enabled !== false) })
      break
    }
    case 'state': {
      if (payload.id) {
        const raw = readJson(stateFile(payload.id))
        // 还没启动过不是 SSH/代理故障；返回 stopped，让控制端把状态归零而不是反复报错。
        const state = raw ? publicState(raw) : { id: payload.id, alive: false, ports: [], log: [] }
        out({ ok: true, state, probe: await probeState(raw || {}) })
      } else {
        const states = []
        for (const file of readdirSync(STATE_ROOT)) {
          const raw = readJson(join(STATE_ROOT, file), {})
          const state = publicState(raw)
          states.push({ ...state, probe: await probeState(raw) })
        }
        out({ ok: true, states })
      }
      break
    }
    case 'pair-status': out(await pairStatus(payload)); break
    case 'pair-issue': out(await pairIssue(payload)); break
    case 'start': out(await start(payload)); break
    case 'stop': out(await stop(payload)); break
    default: fail(`远端代理不支持操作 ${operation}`)
  }
}

async function main() {
  const operation = String(process.argv[2] || '')
  if (!MUTATING_OPERATIONS.has(operation)) return await dispatchMain()
  const release = acquireMutationLock()
  try {
    return await dispatchMain()
  } finally {
    release()
  }
}

main().catch((error) => fail(error?.message || error, { code: error?.code }))
