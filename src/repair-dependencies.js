import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { ordinaryPath, compatibleUpgrade } from './diagnostic-repair.js'

const MANIFEST_LIMIT = 4096
const MANIFEST_BYTES = 1024 * 1024
const TREE_BYTES = 16 * 1024 * 1024
const DIRECTORY_LIMIT = 8192
const DEPTH_LIMIT = 32
const EDGE_LIMIT = 65536
const DEPENDENCY_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']
const PACKAGE_DEPENDENCY_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies']
const PLATFORM_EVIDENCE_SCHEMA = 1
const KNOWN_PLATFORMS = new Set(['aix', 'android', 'darwin', 'freebsd', 'haiku', 'linux', 'netbsd', 'openbsd', 'sunos', 'win32', 'cygwin'])
const KNOWN_ARCHITECTURES = new Set(['arm', 'arm64', 'ia32', 'loong64', 'mips', 'mipsel', 'ppc', 'ppc64', 'riscv64', 's390', 's390x', 'x64'])
const KNOWN_LIBCS = new Set(['glibc', 'musl'])

function validatePlatformSelector(values, known) {
  if (values === undefined) {
    return
  }
  if (!Array.isArray(values) || !values.length || values.some(value => typeof value !== 'string' || !known.has(value.replace(/^!/, '')))) {
    throw new Error('锁文件平台限制格式未知，不能排除缺失依赖。')
  }
}

function platformSelectorExcludes(values, actual, known) {
  validatePlatformSelector(values, known)
  if (values === undefined) {
    return false
  }
  const positive = values.filter(value => !value.startsWith('!'))
  return values.includes(`!${actual}`) || (positive.length > 0 && !positive.includes(actual))
}

function excludedOptionalEvidence(state, name, version, target) {
  const packageKey = `${name}@${version.split('(')[0]}`
  const metadata = state.parsedLock?.packages?.[packageKey]
  const snapshot = state.parsedLock?.snapshots?.[`${name}@${version}`]
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || !snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error(`可选依赖 ${name} 的精确锁条目尚未核实。`)
  }
  // pnpm 11 的 os/cpu/libc 限制按 AND 组合；这里只依据实际 OS/CPU 的互斥，不推测 libc。
  validatePlatformSelector(metadata.libc, KNOWN_LIBCS)
  const excludedOs = platformSelectorExcludes(metadata.os, target.platform, KNOWN_PLATFORMS)
  const excludedCpu = platformSelectorExcludes(metadata.cpu, target.arch, KNOWN_ARCHITECTURES)
  if (!excludedOs && !excludedCpu) {
    throw new Error(`可选依赖 ${name} 未被当前平台限制排除，不能忽略缺失。`)
  }
  return {
    package: packageKey,
    snapshot: `${name}@${version}`,
    os: metadata.os || null,
    cpu: metadata.cpu || null,
    libc: metadata.libc || null,
    evaluated: ['os', 'cpu'],
    skipped: Array.isArray(state.parsedLayout?.skipped) && state.parsedLayout.skipped.includes(packageKey),
  }
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex')
}

function installedSnapshotKeys(state, entry) {
  const key = `${entry.name}@${entry.version}`
  const location = relative(state.profile, entry.dir).replaceAll('\\', '/')
  return Object.entries(state.parsedLayout?.hoistedLocations || {}).filter(([name, paths]) => {
    const versionMatches = name === key || name.startsWith(key + '(') || (name.startsWith(`${entry.name}@`) && state.parsedLock?.packages?.[name]?.version === entry.version)
    return versionMatches && paths.some(path => path.replaceAll('\\', '/') === location)
  }).map(([name]) => name)
}

function dependencyMap(value, label) {
  if (value === undefined) {
    return {}
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(requirement => typeof requirement !== 'string' || !requirement.length)) {
    throw new Error(`${label} 声明格式未知，不能核实完整依赖关系。`)
  }
  return value
}

function verifyManifestEdges(entry, snapshot) {
  const manifest = entry.manifest
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`包 ${entry.name} 缺少已核实的实际依赖声明。`)
  }
  const declaredRequired = dependencyMap(manifest.dependencies, `${entry.name} dependencies`)
  const declaredOptional = dependencyMap(manifest.optionalDependencies, `${entry.name} optionalDependencies`)
  const required = dependencyMap(snapshot.dependencies, `${entry.name} 锁文件 dependencies`)
  const optional = dependencyMap(snapshot.optionalDependencies, `${entry.name} 锁文件 optionalDependencies`)
  for (const name of Object.keys(declaredRequired)) {
    if (!Object.hasOwn(required, name)) {
      throw new Error(`包 ${entry.name} 声明的普通依赖 ${name} 缺少对应普通锁边，不能核实完整依赖关系。`)
    }
  }
  for (const name of Object.keys(declaredOptional)) {
    if (!Object.hasOwn(optional, name) && !Object.hasOwn(required, name)) {
      throw new Error(`包 ${entry.name} 声明的可选依赖 ${name} 缺少锁边；未证实为平台不适用。`)
    }
  }
  return { required, optional }
}

/** 只记录安装清单，不读取凭据或业务文件；任一链接、超限或变化都不作为完整依赖证据。 */
export function installedPackageState(profile) {
  const packages = []
  const files = []
  let bytes = 0
  let directories = 0
  function read(file) {
    ordinaryPath(file)
    const before = statSync(file)
    if (!before.isFile() || before.size > MANIFEST_BYTES || bytes + before.size > TREE_BYTES) {
      throw new Error('安装清单超出核验范围。')
    }
    const text = readFileSync(file, 'utf8')
    const after = statSync(file)
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error('安装清单正在变化。')
    }
    bytes += before.size
    files.push({ path: file, digest: hash(text) })
    return text
  }
  function scan(modules, depth = 0) {
    directories += 1
    if (depth > DEPTH_LIMIT || directories > DIRECTORY_LIMIT) {
      throw new Error('安装目录结构超出核验范围。')
    }
    ordinaryPath(modules)
    for (const entry of readdirSync(modules, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) {
        continue
      }
      const directory = join(modules, entry.name)
      if (entry.isSymbolicLink()) {
        throw new Error('安装依赖含目录链接，未核实完整关系。')
      }
      if (!entry.isDirectory()) {
        continue
      }
      if (entry.name.startsWith('@')) {
        scan(directory, depth + 1)
        continue
      }
      const file = join(directory, 'package.json')
      if (!existsSync(file)) {
        throw new Error('安装包缺少 package.json，依赖关系不完整。')
      }
      if (packages.length >= MANIFEST_LIMIT) {
        throw new Error('安装包数量超出核验范围。')
      }
      const text = read(file)
      const manifest = JSON.parse(text)
      packages.push({ name: manifest.name, version: manifest.version, dir: directory, manifest, digest: hash(text) })
      if (existsSync(join(directory, 'node_modules'))) {
        scan(join(directory, 'node_modules'), depth + 1)
      }
    }
  }
  const manifest = JSON.parse(read(join(profile, 'package.json')))
  const lock = read(join(profile, 'pnpm-lock.yaml'))
  const layout = read(join(profile, 'node_modules', '.modules.yaml'))
  for (const name of ['cordis.patch.yml', 'pnpm-workspace.yaml', '.npmrc']) {
    const file = join(profile, name)
    if (existsSync(file)) {
      read(file)
    }
  }
  scan(join(profile, 'node_modules'))
  for (const file of files) {
    if (hash(readFileSync(file.path)) !== file.digest) {
      throw new Error('安装依赖在核验过程中变化。')
    }
  }
  return { profile, manifest, lock, layout, packages, files, digest: hash(JSON.stringify(files)) }
}

/** 门禁只针对已禁用的直接引入者；等待状态不能替代 disabled 或 required 的证据。 */
export function assessIntroducer(input) {
  if (!input.graphComplete || !input.sourceConfirmed) {
    return '有效配置、实际加载来源或安装依赖证据不完整。'
  }
  if (input.owner.field === 'peerDependencies') {
    return 'peer 声明不是独立的安装引入证据。'
  }
  if (!input.owner.direct || !input.owner.installed) {
    return '未证实这是 profile 直接安装的依赖引入者。'
  }
  if (input.owners.some(owner => owner.dir !== input.owner.dir && !(owner.installed === true && input.removedDirectories?.includes(owner.dir)))) {
    return '还有其他已安装插件依赖同一个冲突包，单独卸载此项不能保证解除遮蔽。'
  }
  if (!input.entries.length || input.entries.some(entry => entry.disabled !== true || entry.required === true)) {
    return '引入者并非全部已确认禁用的非必需配置条目，不能提供诊断卸载。'
  }
  if (!input.fallbackConfirmed) {
    return '没有核实受影响组件的官方兼容替代，禁止卸载依赖引入者。'
  }
  return ''
}

/** 依赖边同时核对锁文件、安装布局和依赖者位置的官方解析结果，不按包名猜来源。 */
export function dependencyOrigins(state, profile, target, resolvePackage, parseYaml) {
  state.parsedLock ??= parseYaml(state.lock)
  state.parsedLayout ??= parseYaml(state.layout)
  const lock = state.parsedLock
  const layout = state.parsedLayout
  if (layout.nodeLinker !== 'hoisted') {
    throw new Error('当前安装布局不是已核实的普通 hoisted 目录。')
  }
  const owners = []
  for (const entry of state.packages) {
    for (const field of PACKAGE_DEPENDENCY_FIELDS) {
      const requirement = entry.manifest[field]?.[target.name]
      if (typeof requirement !== 'string') {
        continue
      }
      const actual = resolvePackage(target.name, entry.dir)
      if (!actual || actual.dir !== target.selected?.dir || actual.version !== target.selected?.version) {
        continue
      }
      const key = `${entry.name}@${entry.version}`
      const snapshotKeys = installedSnapshotKeys(state, entry)
      const snapshots = Object.entries(lock.snapshots || {}).filter(([name]) => snapshotKeys.includes(name))
      const locked = snapshots.length === 1 && [snapshots[0][1].dependencies, snapshots[0][1].optionalDependencies].some(deps => {
        const version = deps?.[target.name]
        return typeof version === 'string' && (version === actual.version || version.startsWith(actual.version + '('))
      })
      const locations = Object.entries(layout.hoistedLocations || {}).filter(([name]) => name === key || name.startsWith(key + '(')).flatMap(([, paths]) => paths)
      const installed = locked && locations.some(path => path.replaceAll('\\', '/') === relative(profile, entry.dir).replaceAll('\\', '/'))
      const rootFields = DEPENDENCY_FIELDS.filter(kind => Object.hasOwn(state.manifest[kind] || {}, entry.name))
      const direct = rootFields.some(kind => {
        const version = lock.importers?.['.']?.[kind]?.[entry.name]?.version
        return typeof version === 'string' && (version === entry.version || version.startsWith(entry.version + '('))
      }) && entry.dir === join(profile, 'node_modules', entry.name)
      owners.push({ name: entry.name, version: entry.version, dir: entry.dir, field, requirement, target: { name: target.name, version: actual.version, dir: actual.dir }, direct, installed, manifest: join(entry.dir, 'package.json') })
    }
  }
  return owners
}

/** 声明依赖闭包仅用于卸载前的预计影响门禁，执行事实仍由卸载后的库存和解析结果决定。 */
export function dependencyRemovalScope(state, owner, resolvePackage, target = { platform: process.platform, arch: process.arch }, satisfiesRange) {
  if (!KNOWN_PLATFORMS.has(target.platform) || !KNOWN_ARCHITECTURES.has(target.arch)) {
    throw new Error('实际运行平台或架构尚未支持核验。')
  }
  const platformEvidence = { schema: PLATFORM_EVIDENCE_SCHEMA, scope: 'current_runtime', target: { platform: target.platform, arch: target.arch }, excluded: [] }
  const mandatory = new Set()
  const nodes = new Map(state.packages.map(entry => [entry.dir, entry]))
  const edges = new Map()
  let edgeCount = 0
  function reachable(start) {
    const found = new Set()
    const pending = [...start]
    while (pending.length) {
      const path = pending.pop()
      if (found.has(path) || !nodes.has(path)) {
        continue
      }
      found.add(path)
      if (!edges.has(path)) {
        const entry = nodes.get(path)
        const snapshotKeys = installedSnapshotKeys(state, entry)
        const snapshots = Object.entries(state.parsedLock?.snapshots || {}).filter(([name]) => snapshotKeys.includes(name))
        if (snapshots.length !== 1) {
          throw new Error(`依赖 ${entry.name} 的锁文件与物理安装上下文未唯一对应。`)
        }
        const declared = verifyManifestEdges(entry, snapshots[0][1])
        const requiredDependencies = declared.required
        const optionalDependencies = declared.optional
        const lockedDependencies = { ...optionalDependencies, ...requiredDependencies }
        const dependencies = []
        for (const [name, version] of Object.entries(lockedDependencies)) {
          edgeCount += 1
          if (edgeCount > EDGE_LIMIT) {
            throw new Error('安装依赖关系超出核验范围。')
          }
          if (typeof version !== 'string') {
            throw new Error('锁文件依赖版本格式尚未支持。')
          }
          const candidates = state.packages.filter(item => item.name === name && (version === item.version || version.startsWith(item.version + '(')))
          const actual = resolvePackage(name, path)
          const optional = Object.hasOwn(optionalDependencies, name) && !Object.hasOwn(requiredDependencies, name)
          if (!optional) {
            mandatory.add(`${name}@${version.split('(')[0]}`)
          }
          if (actual && candidates.some(item => item.dir === actual.dir && item.name === actual.name && item.version === actual.version)) {
            dependencies.push(actual.dir)
          } else if (optional && !actual && candidates.length === 0) {
            const evidence = excludedOptionalEvidence(state, name, version, platformEvidence.target)
            platformEvidence.excluded.push({ from: entry.dir, ...evidence })
          } else if (candidates.length > 1) {
            throw new Error('同版本依赖存在多个物理位置，未核实卸载影响。')
          } else {
            throw new Error(`锁文件依赖 ${name} 未解析到对应版本的已核实安装位置；缺失或版本不一致的原因尚未确认。`)
          }
        }
        edges.set(path, dependencies)
      }
      pending.push(...edges.get(path))
    }
    return found
  }
  const rootDeclarations = new Map(DEPENDENCY_FIELDS.map(field => [field, dependencyMap(state.manifest[field], `profile ${field}`)]))
  const rootNames = new Set([...rootDeclarations.values()].flatMap(declarations => Object.keys(declarations)))
  const keptRoots = []
  for (const name of rootNames) {
    if (name !== owner.name) {
      const fields = DEPENDENCY_FIELDS.filter(field => Object.hasOwn(rootDeclarations.get(field), name))
      const importer = state.parsedLock?.importers?.['.']
      const lockedFields = DEPENDENCY_FIELDS.filter(field => Object.hasOwn(importer?.[field] || {}, name))
      if (fields.length !== 1 || lockedFields.length !== 1 || fields[0] !== lockedFields[0]) {
        throw new Error(`直接依赖 ${name} 的声明与锁文件类别缺失或冲突，不能确认完整卸载范围。`)
      }
      const field = fields[0]
      const requirement = rootDeclarations.get(field)[name]
      const locked = importer[field][name]
      if (!locked || typeof locked !== 'object' || Array.isArray(locked) || locked.specifier !== requirement || typeof locked.version !== 'string' || !locked.version.length) {
        throw new Error(`直接依赖 ${name} 的声明与锁文件版本证据不一致。`)
      }
      const version = locked.version.split('(')[0]
      // 范围语义交给当前官方运行时的 semver；缺少它时不能猜测 ^、tag 或其他来源。
      const rangeConfirmed = typeof satisfiesRange === 'function' ? satisfiesRange(version, requirement) === true : requirement === version && compatibleUpgrade(version, version)
      if (!rangeConfirmed) {
        throw new Error(`直接依赖 ${name} 的锁定版本不满足声明范围，或范围证据未能核实。`)
      }
      const actual = resolvePackage(name, state.profile)
      const installed = actual && nodes.get(actual.dir)
      if (field === 'optionalDependencies' && !actual && !state.packages.some(entry => entry.name === name)) {
        const evidence = excludedOptionalEvidence(state, name, locked.version, platformEvidence.target)
        platformEvidence.excluded.push({ from: state.profile, ...evidence })
        continue
      }
      const snapshotKeys = installed ? installedSnapshotKeys(state, installed) : []
      // 保留项也必须按 importer 的准确上下文核对，不能拿另一版本的完整子图代替。
      if (!installed || installed.name !== name || actual.name !== installed.name || actual.version !== installed.version || installed.version !== version || snapshotKeys.length !== 1 || snapshotKeys[0] !== `${name}@${locked.version}`) {
        throw new Error(`直接依赖 ${name} 未解析到已核实安装位置，不能确认完整卸载范围。`)
      }
      keptRoots.push(actual.dir)
    }
  }
  const kept = reachable(keptRoots)
  const removed = [...reachable([owner.dir])].filter(path => !kept.has(path))
  for (const exclusion of platformEvidence.excluded) {
    if (mandatory.has(exclusion.package)) {
      throw new Error(`依赖 ${exclusion.package} 仍被可达普通依赖引用，不能按可选平台项排除。`)
    }
  }
  return { complete: true, platformEvidence, retainedByOtherRoot: kept.has(owner.dir), predicted: removed.map(path => ({ name: nodes.get(path).name, version: nodes.get(path).version, dir: path })) }
}

/** 执行事实来自前后安装清单库存，不将预计依赖闭包写成已经删除。 */
export function packageStateChanges(before, after) {
  const changes = []
  const previous = new Map(before.packages.map(item => [item.dir, item]))
  const current = new Map(after.packages.map(item => [item.dir, item]))
  for (const [path, entry] of previous) {
    const next = current.get(path)
    if (!next || next.name !== entry.name || next.version !== entry.version || next.digest !== entry.digest) {
      changes.push({ operation: 'package_inventory_changed', path, before: { name: entry.name, version: entry.version, manifestDigest: entry.digest }, after: next ? { name: next.name, version: next.version, manifestDigest: next.digest } : { present: false } })
    }
  }
  for (const [path, entry] of current) {
    if (!previous.has(path)) {
      changes.push({ operation: 'package_inventory_changed', path, before: { present: false }, after: { name: entry.name, version: entry.version } })
    }
  }
  const rootFiles = new Set(['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml', '.npmrc', 'pnpm-workspace.yaml', join('node_modules', '.modules.yaml')].map(name => join(before.profile, name)))
  for (const path of rootFiles) {
    const previousFile = before.files.find(item => item.path === path)
    const next = after.files.find(item => item.path === path)
    if (next?.digest !== previousFile?.digest) {
      changes.push({ operation: 'installation_manifest_changed', path, before: { digest: previousFile?.digest || null }, after: { digest: next?.digest || null } })
    }
  }
  return changes
}
