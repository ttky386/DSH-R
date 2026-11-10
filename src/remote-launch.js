import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { cmpVer, parseVer } from './version.js'

const execFileAsync = promisify(execFile)
const AGENT_FILE = fileURLToPath(new URL('./remote-agent.mjs', import.meta.url))
const AGENT_MODULES = ['./plugins.js', './mcp.js', './skills.js', './packs.js', './zip.js', './zipfile.js', './remote-forward.mjs'].map((file) => fileURLToPath(new URL(file, import.meta.url)))
const NODE_VERSION = 'v22.21.1'
const PNPM_VERSION = process.env.DSH_REMOTE_PNPM_VERSION || '11.27.1'
const REMOTE_ROOT = '.dsh-x-remote'
const REMOTE_NODE = '$HOME/.dsh-x-remote/runtime/node/bin/node'
const REMOTE_AGENT = '$HOME/.dsh-x-remote/lib/remote-agent.mjs'
export const NODE_DIST_BASES = {
  mirror: 'https://cdn.npmmirror.com/binaries/node',
  official: 'https://nodejs.org/dist',
}
const agentReady = new Map()
const agentEnsuring = new Map()

/** 只把一个词变成远端 shell 的单个 argv；所有动态数据先过校验，再经这里传输。 */
export function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`
}

export function remoteIdentityFile(target = {}) {
  const value = String(target.identityFile || '').trim()
  if (!value) return ''
  // 文件选择器很容易把公钥交进来；OpenSSH 要的是同名私钥。
  if (/\.pub$/i.test(value)) {
    const privateKey = value.replace(/\.pub$/i, '')
    if (!existsSync(privateKey)) throw new Error(`选择的是公钥，缺少同名私钥：${privateKey}`)
    return privateKey
  }
  if (existsSync(value)) {
    const info = statSync(value)
    if (info.isFile()) return value
    if (info.isDirectory()) {
      const candidate = ['id_ed25519', 'id_rsa', 'identity', 'identity_ed25519']
        .map((name) => join(value, name))
        .find((file) => existsSync(file) && statSync(file).isFile())
      if (candidate) return candidate
    }
  }
  throw new Error(`SSH 私钥不可访问：${value}（请填文件，例如 D:\\dsh\\.ssh\\id_ed25519）`)
}

export function sshArgs(target, { batchMode = true } = {}) {
  const identityFile = remoteIdentityFile(target)
  const args = [
    '-p', String(target.sshPort),
    ...(identityFile ? ['-i', identityFile] : []),
    // 显式密钥时不再让 ssh 配置/agent 里其它身份抢跑；“测试连接”也能如实报告这张钥匙。
    ...(identityFile ? ['-o', 'IdentitiesOnly=yes'] : []),
    '-o', 'ConnectTimeout=10',
    '-o', 'StrictHostKeyChecking=accept-new',
  ]
  if (batchMode) args.push('-o', 'BatchMode=yes')
  args.push(`${target.user}@${target.host}`)
  return args
}

function sshBinary() {
  return process.platform === 'win32' ? 'ssh.exe' : 'ssh'
}

function scpBinary() {
  return process.platform === 'win32' ? 'scp.exe' : 'scp'
}

function describeSshFailure(text, target) {
  const message = String(text || '').trim()
  if (/bad owner or permissions|permissions are too open|UNPROTECTED PRIVATE KEY/i.test(message)) {
    return `SSH 私钥权限不安全（${message}）。Windows请在“安全”页只保留当前用户和 SYSTEM 的读取权限；或改用 ssh-agent`
  }
  if (/permission denied|authentication failed|no supported authentication/i.test(message)) {
    return `SSH 认证失败：${target.user}@${target.host} 需要可用密钥；密码只用于一次性安装公钥，不会保存`
  }
  if (/timed out|connection timed out|connection refused|network is unreachable|no route to host/i.test(message)) {
    return `SSH 连接 ${target.host}:${target.sshPort} 失败：${message}`
  }
  return message || `SSH ${target.host}:${target.sshPort} 执行失败`
}

class RemoteAgentError extends Error {
  constructor(info) {
    super(info.message || '远端操作失败')
    this.name = 'RemoteAgentError'
    this.code = info.code || 'REMOTE_AGENT_FAILED'
    for (const key of ['processes', 'state', 'probe', 'status']) if (info[key] !== undefined) this[key] = info[key]
  }
}

function remoteAgentErrorFrom(text) {
  const marker = /DSHX_AGENT_ERROR:(.*)/s.exec(String(text || ''))
  if (!marker) return null
  try {
    return new RemoteAgentError(JSON.parse(marker[1]))
  } catch (error) {
    if (error instanceof RemoteAgentError) return error
    return new RemoteAgentError({ message: marker[1] })
  }
}

async function runSsh(target, args, options = {}) {
  try {
    return await execFileAsync(sshBinary(), [...sshArgs(target), ...args], {
      windowsHide: true,
      timeout: options.timeout || 120_000,
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch (error) {
    const agentError = remoteAgentErrorFrom(`${error.stderr || ''}\n${error.stdout || ''}`)
    if (agentError) throw agentError
    const failure = new Error(describeSshFailure(`${error.stderr || ''}\n${error.stdout || ''}\n${error.message}`, target))
    failure.code = error.code || 'SSH_FAILED'
    throw failure
  }
}

async function runSshInput(target, args, input, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(sshBinary(), [...sshArgs(target), ...args], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const outputLimit = 64 * 1024 * 1024
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`SSH ${target.host}:${target.sshPort} 执行超时`))
    }, options.timeout || 180_000)
    const fail = (error) => {
      clearTimeout(timer)
      const agentError = remoteAgentErrorFrom(`${stderr}\n${stdout}`)
      if (agentError) {
        reject(agentError)
        return
      }
      const failure = new Error(describeSshFailure(`${stderr}\n${stdout}\n${error.message}`, target))
      failure.code = error.code || 'SSH_FAILED'
      reject(failure)
    }
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      if (stdout.length > outputLimit) child.kill()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
      if (stderr.length > outputLimit) child.kill()
    })
    child.on('error', fail)
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve({ stdout, stderr })
      else if (stdout.length > outputLimit || stderr.length > outputLimit) fail(new Error('SSH 输出超过 64MB 限制'))
      else fail(new Error(`SSH 退出码 ${code}`))
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

function parseAgentOutput({ stdout, stderr }) {
  const marker = /DSHX_AGENT_ERROR:(.*)/s.exec(String(stderr || ''))
  if (marker) {
    try {
      throw new RemoteAgentError(JSON.parse(marker[1]))
    } catch (error) {
      if (error instanceof RemoteAgentError) throw error
      throw new RemoteAgentError({ message: marker[1] })
    }
  }
  const line = String(stdout || '').trim().split(/\r?\n/).at(-1)
  if (!line) throw new RemoteAgentError({ message: '远端代理没有返回数据' })
  try {
    const value = JSON.parse(line)
    if (value?.ok === false) throw new RemoteAgentError(value)
    return value
  } catch (error) {
    if (error instanceof RemoteAgentError) throw error
    throw new RemoteAgentError({ message: `远端代理返回无法解析的数据：${line.slice(0, 400)}` })
  }
}

async function remoteScript(target, script, { input = '', timeout = 120_000 } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(sshBinary(), [...sshArgs(target), 'sh', '-s'], {
      windowsHide: true,
      stdio: [ 'pipe', 'pipe', 'pipe' ],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`远端脚本执行超时（${Math.round(timeout / 1000)} 秒）`))
    }, timeout)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(new Error(describeSshFailure(error.message, target)))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(describeSshFailure(`${stderr}\n${stdout}`, target)))
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input ? `${script}\n${input}` : `${script}\n`)
  })
}

/**
 * 只验证 SSH 网络可达、认证成功和远端 shell 可执行。
 * 不检查 DSH、Node、npm，也不访问任何远端 HTTP 管理端口。
 */
export async function remoteSshProbe(target) {
  const identityFile = remoteIdentityFile(target)
  const marker = `DSHX_SSH_OK_${Date.now().toString(36)}`
  const { stdout } = await runSsh(target, ['printf', '%s', marker], { timeout: 20_000 })
  if (String(stdout).trim() !== marker) throw new Error('SSH 已连接，但远端 shell 返回异常数据')
  return {
    ok: true,
    host: target.host,
    user: target.user,
    sshPort: target.sshPort,
    authMode: identityFile ? 'identity-file' : 'ssh-config-or-agent',
    identityFile,
  }
}

function linuxArch(value) {
  if (['x86_64', 'amd64'].includes(String(value))) return 'x64'
  if (['aarch64', 'arm64'].includes(String(value))) return 'arm64'
  throw new Error(`远端只支持 x64/arm64 Linux，当前架构是 ${value || '未知'}`)
}

async function remoteRuntimeInfo(target) {
  const script = `set -eu
printf 'ARCH='; uname -m
printf 'NODE='; if [ -x ${REMOTE_NODE} ]; then ${REMOTE_NODE} -p process.version; else printf 'missing\\n'; fi
printf 'CURL='; command -v curl || printf 'missing\\n'
printf 'TAR='; command -v tar || printf 'missing\\n'
printf 'XZ='; command -v xz || printf 'missing\\n'
printf 'HOME='; printf '%s\\n' "$HOME"`
  const { stdout } = await remoteScript(target, script, { timeout: 30_000 })
  const values = Object.fromEntries(String(stdout).trim().split(/\r?\n/).map((line) => {
    const at = line.indexOf('=')
    return at > 0 ? [line.slice(0, at), line.slice(at + 1)] : [line, '']
  }))
  return values
}

export async function ensureRemoteRuntime(target, { source = 'mirror' } = {}) {
  const info = await remoteRuntimeInfo(target)
  const base = NODE_DIST_BASES[source] || NODE_DIST_BASES.mirror
  if (info.NODE === 'missing') {
    const arch = linuxArch(info.ARCH)
    const url = `${base}/${NODE_VERSION}/node-${NODE_VERSION}-linux-${arch}.tar.xz`
    if (info.CURL === 'missing' || info.TAR === 'missing' || info.XZ === 'missing') {
      throw new Error('远端缺少 curl/tar/xz，无法安装 Linux x64/arm64 Node 运行时')
    }
    const script = `set -eu
umask 077
mkdir -p "$HOME/${REMOTE_ROOT}/runtime"
tmp=$(mktemp -d "$HOME/${REMOTE_ROOT}/runtime/.bootstrap.XXXXXX")
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
curl --fail --location --retry 3 --connect-timeout 15 --output "$tmp/node.tar.xz" ${shellQuote(url)}
tar -xJf "$tmp/node.tar.xz" -C "$tmp"
dir=$(find "$tmp" -mindepth 1 -maxdepth 1 -type d -name 'node-*' | head -1)
[ -n "$dir" ]
if [ -e "$HOME/${REMOTE_ROOT}/runtime/node" ]; then rm -rf "$tmp"; else mv "$dir" "$HOME/${REMOTE_ROOT}/runtime/node"; fi
${REMOTE_NODE} -p process.version`
    const result = await remoteScript(target, script, { timeout: 1_800_000 })
    if (!String(result.stdout).includes(NODE_VERSION)) throw new Error('远端 Node 运行时安装后校验失败')
  }
  const pnpmScript = `set -eu
umask 077
if [ ! -x "$HOME/${REMOTE_ROOT}/runtime/node/bin/pnpm" ] || [ "$("$HOME/${REMOTE_ROOT}/runtime/node/bin/pnpm" --version 2>/dev/null || true)" != "${PNPM_VERSION}" ]; then
  PATH="$HOME/${REMOTE_ROOT}/runtime/node/bin:$PATH"
  "$HOME/${REMOTE_ROOT}/runtime/node/bin/npm" install --global pnpm@${PNPM_VERSION} --force --registry=${shellQuote(base === NODE_DIST_BASES.official ? 'https://registry.npmjs.org' : 'https://registry.npmmirror.com')} --no-audit --no-fund
fi
PATH="$HOME/${REMOTE_ROOT}/runtime/node/bin:$PATH"
"$HOME/${REMOTE_ROOT}/runtime/node/bin/pnpm" --version`
  const pnpmResult = await remoteScript(target, pnpmScript, { timeout: 600_000 })
  if (!String(pnpmResult.stdout).includes(PNPM_VERSION)) throw new Error(`远端 pnpm ${PNPM_VERSION} 安装后校验失败`)
  return { node: info.NODE === 'missing' ? NODE_VERSION : info.NODE, pnpm: PNPM_VERSION, arch: linuxArch(info.ARCH) }
}

async function ensureRemoteAgentNow(target, options = {}) {
  const files = [AGENT_FILE, ...AGENT_MODULES]
  const sources = await Promise.all(files.map((file) => readFile(file, 'utf8')))
  const digest = createHash('sha256').update(sources.join('\n\n/* DSH-X module boundary */\n\n')).digest('hex')
  const identityFile = remoteIdentityFile(target)
  const key = `${target.user}@${target.host}:${target.sshPort}:${identityFile}:${digest}`
  if (agentReady.get(key) === true) return true
  await ensureRemoteRuntime(target, options)
  const check = `set -eu
for file in ${REMOTE_AGENT} $HOME/${REMOTE_ROOT}/lib/plugins.js $HOME/${REMOTE_ROOT}/lib/mcp.js $HOME/${REMOTE_ROOT}/lib/skills.js $HOME/${REMOTE_ROOT}/lib/packs.js $HOME/${REMOTE_ROOT}/lib/zip.js $HOME/${REMOTE_ROOT}/lib/zipfile.js $HOME/${REMOTE_ROOT}/lib/remote-forward.mjs; do
  [ -f "$file" ] || { printf MISSING; exit 0; }
done
[ "$(cat "$HOME/${REMOTE_ROOT}/lib/.agent-hash" 2>/dev/null || true)" = ${shellQuote(digest)} ] || { printf MISSING; exit 0; }
printf SYNC`
  const state = (await remoteScript(target, check, { timeout: 30_000 })).stdout.trim()
  if (state !== 'SYNC') {
    // 不能用 `ssh sh -s` 里嵌 cat：远端 sh 会预读一块 stdin，代理文件开头会被 shell 吃掉。
    // scp 走独立文件传输，远端文件与本地逐字节一致。Tailscale 目标单次 SSH 往返可能
    // 接近 5 秒；逐文件 scp+mv 会在高延迟下超时，所以一批传完、一条命令统一落位。
    const stage = `${REMOTE_ROOT}/lib/.stage-${Date.now().toString(36)}`
    let stageCleaned = false
    await runSsh(target, ['mkdir', '-p', `${REMOTE_ROOT}/lib`, stage], { timeout: 60_000 })
    try {
      await execFileAsync(scpBinary(), [
        '-P', String(target.sshPort),
        ...(identityFile ? ['-i', identityFile] : []),
        ...(identityFile ? ['-o', 'IdentitiesOnly=yes'] : []),
        '-o', 'ConnectTimeout=10',
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', 'BatchMode=yes',
        ...files,
        `${target.user}@${target.host}:${stage}/`,
      ], { windowsHide: true, timeout: 180_000, maxBuffer: 1024 })
      const moves = files.map((file) => {
        const name = basename(file)
        return `mv -f "$HOME/${stage}/${name}" "$HOME/${REMOTE_ROOT}/lib/${name}"`
      })
      await runSsh(target, [
        'set', '-eu', ';',
        ...moves.flatMap((move) => [move, '&&']),
        'chmod', '600', `$HOME/${REMOTE_ROOT}/lib/*`, ';',
        'printf', '%s', shellQuote(digest), '>', `$HOME/${REMOTE_ROOT}/lib/.agent-hash`, ';',
        'rm', '-rf', `$HOME/${stage}`,
      ], { timeout: 60_000 })
      stageCleaned = true
    } catch (error) {
      throw new Error(describeSshFailure(error.stderr || error.message, target))
    } finally {
      if (!stageCleaned) await runSsh(target, ['rm', '-rf', `$HOME/${stage}`], { timeout: 30_000 }).catch(() => {})
    }
  }
  agentReady.set(key, true)
  return true
}

async function ensureRemoteAgent(target, options = {}) {
  const identityFile = remoteIdentityFile(target)
  // digest 由 ensureRemoteAgentNow 计算；key 只需要先区分目标，后续请求会在锁内复用同一个 digest。
  const targetKey = `${target.user}@${target.host}:${target.sshPort}:${identityFile}`
  const existing = agentEnsuring.get(targetKey)
  if (existing) return existing
  const ensuring = ensureRemoteAgentNow(target, options)
  agentEnsuring.set(targetKey, ensuring)
  try {
    return await ensuring
  } finally {
    agentEnsuring.delete(targetKey)
  }
}

export async function remoteExec(target, operation, payload = {}, options = {}) {
  await ensureRemoteAgent(target, options)
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
  // $HOME 必须留给远端 shell 展开。payload 走 stdin：技能包可达 16MB，放 argv 会撞 ARG_MAX。
  const command = [REMOTE_NODE, REMOTE_AGENT, shellQuote(operation), '--stdin'].join(' ')
  const result = await runSshInput(target, [command], encoded, { timeout: options.timeout || 180_000 })
  return parseAgentOutput(result)
}

export async function remoteEnvironment(target, dshHome = '', options = {}) {
  return await remoteExec(target, 'facts', { dshHome }, options)
}

export function remoteVersionChoice({ tags = {}, versions: published = [], installed = [], channel = 'official', usedVersion = '' } = {}) {
  const tagName = channel === 'official' ? 'latest' : channel
  const direct = String(tags[tagName] || '')
  if (direct) return direct
  const versions = [...(Array.isArray(published) ? published : [])]
    .concat(installed.map((item) => item.version || item))
    .filter(Boolean)
  const stable = versions.filter((version) => !/-(?:rc|alpha|beta|canary)/i.test(version))
  const candidates = channel === 'official'
    ? (stable.length ? stable : versions)
    : versions.filter((version) => new RegExp(`-${channel}`, 'i').test(version))
  const best = [...new Set(candidates)].sort((left, right) => cmpVer(parseVer(right), parseVer(left)))[0]
  return best || usedVersion || ''
}

export async function prepareRemoteVersion(target, { dshHome = '', version = 'auto', updateChannel = 'official', usedVersion = '' }, options = {}) {
  const list = await remoteExec(target, 'version-list', { dshHome, registry: registryUrl(options.registry) }, { ...options, timeout: 60_000 })
  const wanted = version && version !== 'auto'
    ? version
    : remoteVersionChoice({ tags: list.tags, versions: list.versions, installed: list.installed, channel: updateChannel, usedVersion })
  if (!wanted) throw new Error('远端 npm 没有返回可用的 DSH 版本')
  if (!list.installed.some((item) => item.version === wanted)) {
    await remoteExec(target, 'version-install', { dshHome, version: wanted, registry: registryUrl(options.registry) }, { ...options, timeout: 1_800_000 })
  }
  return wanted
}

function registryUrl(registry) {
  return String(registry || 'https://registry.npmmirror.com').replace(/\/$/, '')
}

export async function remoteStartEntry(target, entry, options = {}) {
  const version = await prepareRemoteVersion(target, entry, options)
  return await remoteExec(target, 'start', {
    id: entry.id,
    dshHome: entry.dshHome || '',
    profile: entry.profile,
    version,
    bind: options.bind || '0.0.0.0',
    port: entry.port || 0,
    publicHost: target.host,
    takeover: options.takeover === true,
  }, { ...options, timeout: 180_000 })
}

export async function remoteStopEntry(target, id, options = {}) {
  return await remoteExec(target, 'stop', { id }, options)
}

export async function remoteState(target, id = '', options = {}) {
  return await remoteExec(target, 'state', id ? { id } : {}, options)
}

export async function remotePairStatus(target, id, options = {}) {
  return await remoteExec(target, 'pair-status', { id }, { ...options, timeout: 15_000 })
}

export async function remotePairIssue(target, id, address = '', options = {}) {
  return await remoteExec(target, 'pair-issue', { id, ...(address ? { address } : {}) }, { ...options, timeout: 15_000 })
}

export async function remoteProfiles(target, dshHome = '', options = {}) {
  return await remoteExec(target, 'profile-list', { dshHome }, options)
}

export async function remoteProfileCreate(target, dshHome, profile, options = {}) {
  return await remoteExec(target, 'profile-create', { dshHome, profile }, options)
}

export async function remoteProfileRename(target, dshHome, from, to, options = {}) {
  return await remoteExec(target, 'profile-rename', { dshHome, from, to }, options)
}

export async function remoteProfileDelete(target, dshHome, profile, confirmPath, options = {}) {
  return await remoteExec(target, 'profile-delete', { dshHome, profile, confirmPath }, options)
}

export async function remoteProfileRecover(target, dshHome, profile, options = {}) {
  return await remoteExec(target, 'profile-recover', { dshHome, profile }, options)
}

export async function remoteProfileRecoverList(target, dshHome, profile, options = {}) {
  return await remoteExec(target, 'profile-recover-list', { dshHome, profile }, options)
}

export async function remoteProfileRecoverRestore(target, dshHome, profile, backup, options = {}) {
  return await remoteExec(target, 'profile-recover-restore', { dshHome, profile, backup }, options)
}

export async function remoteConfigRead(target, dshHome, profile, file, options = {}) {
  return await remoteExec(target, 'config-read', { dshHome, profile, file }, options)
}

export async function remoteConfigWrite(target, dshHome, profile, file, content, options = {}) {
  return await remoteExec(target, 'config-write', { dshHome, profile, file, content }, options)
}

export async function remoteFileCapabilities(target, dshHome, profile, version = 'auto', options = {}) {
  return await remoteExec(target, 'file-capabilities', { dshHome, profile, version }, options)
}

export async function remoteFileList(target, dshHome, path = '.', options = {}) {
  return await remoteExec(target, 'file-list', { dshHome, path }, options)
}

export async function remoteFileRead(target, dshHome, path, mode = 'auto', options = {}) {
  return await remoteExec(target, 'file-read', { dshHome, path, mode }, { ...options, timeout: 60_000 })
}

export async function remoteCredentialsList(target, dshHome, options = {}) {
  return await remoteExec(target, 'credentials-list', { dshHome }, options)
}

export async function remoteCredentialSet(target, dshHome, name, value, options = {}) {
  return await remoteExec(target, 'credentials-set', { dshHome, name, value }, options)
}

export async function remoteCredentialUnset(target, dshHome, name, options = {}) {
  return await remoteExec(target, 'credentials-unset', { dshHome, name }, options)
}

export async function remotePlugins(target, dshHome, profile, options = {}) {
  return await remoteExec(target, 'plugin-list', { dshHome, profile }, options)
}

export async function remotePluginToggle(target, dshHome, profile, name, enabled, options = {}) {
  return await remoteExec(target, 'plugin-toggle', { dshHome, profile, name, enabled }, { ...options, timeout: 60_000 })
}

export async function remotePluginInstall(target, dshHome, profile, spec, version, options = {}) {
  return await remoteExec(target, 'plugin-install', { dshHome, profile, spec, version }, { ...options, timeout: 1_800_000 })
}

export async function remotePluginRemove(target, dshHome, profile, name, version, options = {}) {
  return await remoteExec(target, 'plugin-remove', { dshHome, profile, name, version }, { ...options, timeout: 1_800_000 })
}

export async function remotePluginUpdate(target, dshHome, profile, name, all = false, options = {}) {
  return await remoteExec(target, 'plugin-update', { dshHome, profile, ...(all ? { all: true } : { name }) }, { ...options, timeout: 1_800_000 })
}

export async function remoteDependencyCheck(target, dshHome, profile, version, repair = false, options = {}) {
  return await remoteExec(target, repair ? 'dependency-repair' : 'dependency-check', { dshHome, profile, version }, { ...options, timeout: repair ? 1_800_000 : 60_000 })
}

export async function remotePackList(target, dshHome, profile, options = {}) {
  return await remoteExec(target, 'pack-list', { dshHome, profile }, options)
}

export async function remotePackInstall(target, dshHome, profile, bytes, source = '', options = {}) {
  // Buffer 直接 JSON.stringify 会展开成数百万个数字；base64 稳定得多，也避免 SSH 输入膨胀。
  return await remoteExec(target, 'pack-install', { dshHome, profile, bytes: bytes.toString('base64'), source }, { ...options, timeout: 1_800_000 })
}

export async function remotePackUninstall(target, dshHome, profile, name, options = {}) {
  return await remoteExec(target, 'pack-uninstall', { dshHome, profile, name }, options)
}

export async function remotePackExport(target, dshHome, body = {}, options = {}) {
  return await remoteExec(target, 'pack-export', { dshHome, ...body, profile: body.profile }, { ...options, timeout: 180_000 })
}

export async function remoteVersionOptimize(target, dshHome, profile, version, options = {}) {
  return await remoteExec(target, 'version-optimize', { dshHome, profile, version }, { ...options, timeout: 1_800_000 })
}

export async function remoteVersionReplace(target, dshHome, profile, version, registry = '', options = {}) {
  return await remoteExec(target, 'version-replace', { dshHome, profile, version, registry }, { ...options, timeout: 1_800_000 })
}

export async function remoteMcpList(target, dshHome, profile, options = {}) {
  return await remoteExec(target, 'mcp-list', { dshHome, profile }, options)
}

export async function remoteMcpProbe(target, dshHome, profile, options = {}) {
  return await remoteExec(target, 'mcp-probe', { dshHome, profile, timeoutMs: options.timeoutMs }, { ...options, timeout: 180_000 })
}

export async function remoteMcpSave(target, dshHome, profile, spec, options = {}) {
  return await remoteExec(target, 'mcp-save', { dshHome, profile, spec }, options)
}

export async function remoteMcpToggle(target, dshHome, profile, name, enabled, options = {}) {
  return await remoteExec(target, 'mcp-toggle', { dshHome, profile, name, enabled }, options)
}

export async function remoteMcpRemove(target, dshHome, profile, name, options = {}) {
  return await remoteExec(target, 'mcp-remove', { dshHome, profile, name }, options)
}

export async function remoteSkillsList(target, dshHome, profile, options = {}) {
  return await remoteExec(target, 'skills-list', { dshHome, profile }, options)
}

export async function remoteSkillDetail(target, dshHome, profile, root, relPath, options = {}) {
  return await remoteExec(target, 'skills-detail', { dshHome, profile, root, relPath }, options)
}

export async function remoteSkillInstall(target, dshHome, profile, root, packages, selected, options = {}) {
  const serialized = (packages || []).map((item) => ({
    ...item,
    files: (item.files || []).map((file) => ({ ...file, data: Buffer.isBuffer(file.data) ? file.data.toString('base64') : file.data })),
  }))
  return await remoteExec(target, 'skills-install', { dshHome, profile, root, packages: serialized, selected }, options)
}

export async function remoteSkillCreate(target, dshHome, profile, body, options = {}) {
  return await remoteExec(target, 'skills-create', { dshHome, profile, ...body }, options)
}

export async function remoteSkillToggle(target, dshHome, profile, root, relPath, enabled, options = {}) {
  return await remoteExec(target, 'skills-toggle', { dshHome, profile, root, relPath, enabled }, options)
}

export async function remoteSkillRemove(target, dshHome, profile, root, relPath, options = {}) {
  return await remoteExec(target, 'skills-remove', { dshHome, profile, root, relPath }, options)
}
