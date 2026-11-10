import { createHash } from 'node:crypto'
import { readFileSync, closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { ordinaryPath } from './diagnostic-repair.js'

const MAX_FILES = 2048
const MAX_BYTES = 80 * 1024 * 1024
const MAX_DEPTH = 12
const MAX_FILE_BYTES = 16 * 1024 * 1024
// 本次官方构建的 host/client 实现与清单已核：只有上报组内部的必需依赖，UI消费者为可选调用。
const REVIEWED_BUILD = "311d24219df13bcd3c07e6899e6bc8fddedf765a0225423fbe81f7f8030a0dc3"

/** 限定已核官方代码集合；不同构建或任意文件变化均不得沿用可选性结论。 */
export function optionalAnalyticsProof(runtimeModules) {
  const scope = join(runtimeModules, '@deepseek-ai')
  ordinaryPath(scope)
  const entries = []
  let bytes = 0
  function visit(directory, depth) {
    if (depth > MAX_DEPTH) {
      throw new Error('可选性证据目录过深')
    }
    const names = readdirSync(directory).sort()
    for (const name of names) {
      const path = join(directory, name)
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) {
        throw new Error('可选性证据包含链接')
      }
      if (stat.isDirectory()) {
        visit(path, depth + 1)
      } else if (stat.isFile() && /\.(?:js|mjs|cjs)$/.test(name)) {
        addFile(path)
      }
    }
    if (JSON.stringify(names) !== JSON.stringify(readdirSync(directory).sort())) {
      throw new Error('可选性证据目录变化')
    }
  }
  function addFile(path) {
    const descriptor = openSync(path, 'r')
    try {
      const before = fstatSync(descriptor)
      bytes += before.size
      if (!before.isFile() || before.size > MAX_FILE_BYTES || bytes > MAX_BYTES || entries.length >= MAX_FILES) {
        throw new Error('可选性证据超出读取上限')
      }
      const content = Buffer.alloc(before.size + 1)
      let length = 0
      while (length < content.length) {
        const count = readSync(descriptor, content, length, content.length - length, length)
        if (count === 0) {
          break
        }
        length += count
      }
      const after = fstatSync(descriptor)
      if (length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
        throw new Error('可选性证据文件变化')
      }
      entries.push([relative(scope, path).replaceAll('\\', '/'), length, createHash('sha256').update(content.subarray(0, length)).digest('hex')])
    } finally {
      closeSync(descriptor)
    }
  }
  const packages = readdirSync(scope).sort()
  for (const name of packages) {
    const directory = join(scope, name)
    ordinaryPath(directory)
    if (!lstatSync(directory).isDirectory()) {
      throw new Error('官方包目录未知')
    }
    const manifestFile = join(directory, 'package.json')
    addFile(manifestFile)
    if (name === 'dsh-base' || name === 'dsh-web-app') {
      const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
      const patches = manifest.dsh?.bundle?.patch
      for (const patch of typeof patches === 'string' ? [patches] : patches || []) {
        if (typeof patch !== 'string' || patch.includes('..') || patch.startsWith('/') || patch.includes(':')) {
          throw new Error('未知官方模板路径')
        }
        const filename = join(directory, patch)
        ordinaryPath(filename)
        addFile(filename)
      }
    }
    const children = readdirSync(directory)
    if (children.includes('lib')) {
      ordinaryPath(join(directory, 'lib'))
      visit(join(directory, 'lib'), 0)
    }
  }
  if (JSON.stringify(packages) !== JSON.stringify(readdirSync(scope).sort())) {
    throw new Error('官方包集合变化')
  }
  const fingerprint = createHash('sha256').update(JSON.stringify(entries)).digest('hex')
  return { allowed: fingerprint === REVIEWED_BUILD, fingerprint, files: entries.length, bytes }
}
