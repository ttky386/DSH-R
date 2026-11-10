// 核心的 npm 分发：查 registry 的 dist-tags → 下载 tarball → 校验 → 解压。
//
// 安装包只负责外壳和 Electron；核心作为一个 npm 包独立发版，启动器在运行时从 registry
// 取新版本，解到暂存目录后仍走 apply-update.mjs 换核心目录。
// 核心包跨平台（三套 filemanager 和 node 包装都在里面），Windows / mac / Linux 用同一个
// dsh-x-remote-core；只有外壳/Electron 按平台分开。
// 完整性用 npm 的 dist.integrity（sha512）校验；registry 走设置里的下载源（官方/镜像）。

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { netFetch } from './proxy.js'
import { cmpVer, parseVer, VERSION_CHANNEL } from './version.js'

/** 核心包跨平台：Windows / mac / Linux 共用二开专用的 dsh-x-remote-core。 */
export const CORE_PACKAGE = String(process.env.DSH_CORE_PACKAGE || 'dsh-x-remote-core').trim()

export const CORE_REGISTRIES = {
  official: 'https://registry.npmjs.org',
  mirror: 'https://registry.npmmirror.com',
}

/** 核心包上限：app 层约 15 MB，超过这个数八成是错误页或别的文件。 */
export const CORE_MAX_BYTES = 128 * 1024 * 1024

const CHANNEL_TAG = {
  [VERSION_CHANNEL.OFFICIAL]: 'latest',
  [VERSION_CHANNEL.RC]: 'rc',
  [VERSION_CHANNEL.ALPHA]: 'alpha',
}

/** 测试通道可以显式指定 registry；否则按下载源在官方/镜像之间选。 */
export function coreRegistry(source = 'official') {
  const override = String(process.env.DSH_CORE_REGISTRY || '').trim().replace(/\/+$/, '')
  if (override) return override
  return CORE_REGISTRIES[source] || CORE_REGISTRIES.official
}

export function coreMetadataUrl(registry, name = CORE_PACKAGE) {
  return `${String(registry).replace(/\/+$/, '')}/${name.startsWith('@') ? name.replace('/', '%2F') : name}`
}

export function coreDistTag(channel = VERSION_CHANNEL.OFFICIAL) {
  return CHANNEL_TAG[channel] || 'latest'
}

/** 从 npm 元数据里挑当前通道对应的版本；挑不到返回 null。 */
export function resolveCoreRelease(metadata, channel = VERSION_CHANNEL.OFFICIAL) {
  const tags = metadata?.['dist-tags'] || {}
  const version = String(tags[coreDistTag(channel)] || tags.latest || '')
  const info = version ? metadata?.versions?.[version] : null
  if (!info) return null
  const dist = info.dist || {}
  return {
    version,
    tarball: String(dist.tarball || ''),
    integrity: String(dist.integrity || ''),
    shasum: String(dist.shasum || ''),
    unpackedSize: Number(dist.unpackedSize) || 0,
    // 发布脚本写进核心 package.json：这份核心是按哪个 Electron 版本构建/验证的
    electron: String(info.dshX?.electron || ''),
  }
}

export async function fetchCoreMetadata({ registry = coreRegistry(), name = CORE_PACKAGE, signal } = {}) {
  const url = coreMetadataUrl(registry, name)
  const res = await netFetch(url, {
    redirect: 'follow',
    headers: { accept: 'application/json', 'user-agent': 'dsh-x' },
    signal,
  })
  if (!res.ok) throw new Error(`读取 ${name} 的 npm 元数据失败：HTTP ${res.status}`)
  return res.json()
}

/** 查核心更新：返回 { available, current, latest, release }。 */
export async function checkCoreUpdate({ current, source = 'official', channel = VERSION_CHANNEL.OFFICIAL, signal } = {}) {
  const metadata = await fetchCoreMetadata({ registry: coreRegistry(source), signal })
  const release = resolveCoreRelease(metadata, channel)
  if (!release) return { available: false, current, latest: '' }
  const next = parseVer(release.version)
  const cur = parseVer(current)
  return { available: Boolean(next && cur && cmpVer(next, cur) > 0), current, latest: release.version, release }
}

/**
 * 一次元数据查询里看多个通道，取高于当前版本里最高的那个（「接受预览版」开关用）。
 * 只查一次 registry：三个 dist-tag 在同一份文档里，分三次查纯属浪费。
 */
export async function checkCoreUpdateAny({ current, source = 'official', channels = [], signal } = {}) {
  const metadata = await fetchCoreMetadata({ registry: coreRegistry(source), signal })
  const cur = parseVer(current)
  let best = null
  for (const channel of channels) {
    const release = resolveCoreRelease(metadata, channel)
    const next = release ? parseVer(release.version) : null
    if (!next || !cur || cmpVer(next, cur) <= 0) continue
    if (!best || cmpVer(next, parseVer(best.version)) > 0) best = release
  }
  if (!best) return { available: false, current, latest: '' }
  return { available: true, current, latest: best.version, release: best }
}

/** 下载 tarball，边下边算 sha512；有 integrity 就按 npm 的 SRI 校验，否则退回 sha1。 */
export async function downloadCoreTarball(url, dest, { integrity = '', shasum = '', signal, onProgress, limit = CORE_MAX_BYTES } = {}) {
  if (!url) throw new Error('核心包没有下载地址')
  const res = await netFetch(url, { redirect: 'follow', signal })
  if (!res.ok) throw new Error(`下载核心包失败：HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length')) || 0
  if (total > limit) throw new Error(`核心包太大（${Math.round(total / 1048576)} MB，上限 ${Math.round(limit / 1048576)} MB）`)
  const hash = createHash('sha512')
  const out = createWriteStream(dest, { flags: 'w' })
  let done = 0
  const closed = new Promise((resolve, reject) => {
    out.once('close', resolve)
    out.once('error', reject)
  })
  try {
    for await (const chunk of res.body) {
      signal?.throwIfAborted()
      done += chunk.length
      if (done > limit) throw new Error('核心包太大，已停下')
      hash.update(chunk)
      if (!out.write(chunk)) {
        await new Promise((resolve, reject) => {
          out.once('drain', resolve)
          out.once('error', reject)
        })
      }
      onProgress?.({ done, total })
    }
    out.end()
    await closed
  } catch (error) {
    out.destroy()
    await closed.catch(() => {})
    throw error
  }
  const digest = hash.digest('base64')
  if (integrity) {
    const expected = String(integrity).replace(/^sha512-/, '')
    if (digest !== expected) throw new Error('核心包的 sha512 校验失败')
  } else if (shasum) {
    const sha1 = createHash('sha1').update(readFileSync(dest)).digest('hex')
    if (sha1 !== String(shasum).toLowerCase()) throw new Error('核心包的 sha1 校验失败')
  }
  return { bytes: done, sha512: digest }
}

/** 解压用的 tar：Windows 上用系统自带的 bsdtar（Git 的 GNU tar 会把 C: 当远程主机）。 */
export function tarCommand() {
  if (process.platform === 'win32') {
    const system = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    return existsSync(system) ? system : 'tar'
  }
  return '/usr/bin/tar'
}

/** 在 Windows 上打的 tarball 里 POSIX 包装可能没有可执行位；解到 mac 后补上。 */
function ensurePosixShims(dest) {
  if (process.platform === 'win32') return
  for (const name of ['node', 'npm', 'npx', 'pnpm', 'pnpx']) {
    try { chmodSync(join(dest, 'node', name), 0o755) } catch { /* 没有就跳过 */ }
  }
}

/** npm tarball 里所有文件都在 package/ 下；解包时剥掉这一层。 */
export function extractCoreTarball(tarball, dest) {
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  const result = spawnSync(tarCommand(), ['-xzf', tarball, '-C', dest, '--strip-components=1'], { windowsHide: true, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`解压核心包失败：${String(result.stderr || result.status).trim()}`)
  if (!existsSync(join(dest, 'server.js')) || !existsSync(join(dest, 'package.json'))) {
    throw new Error('核心包里缺少 server.js 或 package.json')
  }
  ensurePosixShims(dest)
  return JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8'))
}

export function stagingExists(dir, marker = 'server.js') {
  return Boolean(dir) && existsSync(join(dir, marker))
}

export function stagingStats(dir) {
  let files = 0
  let bytes = 0
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) {
        files += 1
        bytes += statSync(path).size
      }
    }
  }
  walk(dir)
  return { files, bytes }
}
