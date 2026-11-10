// 只在独立短生命周期进程内安装官方解析钩子，不启动 Harness 或加载插件实现。
import { readFileSync, existsSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { configurationSources } from './configuration-evidence.js'
import { optionalAnalyticsProof } from './optional-analytics-proof.js'
import { packageFingerprint, ordinaryPath, compatibleUpgrade } from './diagnostic-repair.js'
import { optionsDigest, schemaDisableReason, importDisableReason } from './runtime-diagnostics.mjs'
import { installedPackageState, dependencyOrigins, dependencyRemovalScope, assessIntroducer } from './repair-dependencies.js'

const REVIEWED_LOCAL_OVERRIDES = {
  "@deepseek-ai/dsh-credentials-local": "2a108b982ab8425582fe547ddb7c1409f64605cab933c8522b053431d54d4f72",
  "@deepseek-ai/dsh-session-persistence-jsonl": "d4ded569bf5b2cb7b67a8a05e4d21e82b76452034176b7ada912a417924e0f42",
  "@deepseek-ai/dsh-subprocess-local": "a6ccd77cbd5c121ee6aa2b0b0c92b0ed0f16b4b106c1c300f1d9f675faa7dd56"
}

const INPUT_MAX_BYTES = 65536
const TARGET_MAX_COUNT = 32
const CONFIG_FILE_LIMIT = 64
const CONFIG_BYTE_LIMIT = 1024 * 1024

async function main() {
  let input = ''
  for await (const chunk of process.stdin) {
    input += chunk
    if (Buffer.byteLength(input) > INPUT_MAX_BYTES) {
      throw new Error('oversized_probe_input')
    }
  }
  const { anchor, home, profile, names, acceptedPatchDigest, runtimeEvidence } = JSON.parse(input)
  if (!Array.isArray(names) || names.length > TARGET_MAX_COUNT || names.some(name => !/^@deepseek-ai\/[a-z0-9][a-z0-9._-]*$/.test(name))) {
    throw new Error('invalid_probe_targets')
  }
  const runtime = dirname(dirname(dirname(anchor)))
  const manifest = JSON.parse(readFileSync(anchor, 'utf8'))
  const boot = await import(pathToFileURL(join(runtime, '@deepseek-ai/dsh-app-boot/lib/index.js')))
  const { Context } = await import(pathToFileURL(join(runtime, '@deepseek-ai/cordis/lib/index.js')))
  const profileDir = join(home, 'profiles', profile)
  const profileManifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  const bundles = profileManifest.dsh?.profile?.bundles
  if (!Array.isArray(bundles) || bundles.some(name => typeof name !== 'string')) {
    throw new Error('unverifiable_profile_bundles')
  }
  // loadProfileDirectory 会移除 retired bundle，故这里只构造 resolver 所需只读字段。
  const loaded = { dir: profileDir, layers: [], skippedBundles: [] }
  let rootConfirmed = bundles.length > 0 && bundles.every(name => ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'].includes(name))
  let telemetryConfirmed = false
  let telemetrySource = null
  let telemetryDeclarations = 0
  let optionalRowsConfirmed = false
  const bundleDigests = []
  const compositionLayers = []
  const compositionFiles = []
  const skippedBundleEvidence = []
  function loadComposition(file) {
    ordinaryPath(file)
    if (compositionFiles.length >= CONFIG_FILE_LIMIT || statSync(file).size > CONFIG_BYTE_LIMIT) {
      throw new Error('oversized_composition')
    }
    const before = createHash('sha256').update(readFileSync(file)).digest('hex')
    const parsed = boot.loadOverlayPatches('dsh', file)
    if (statSync(file).size > CONFIG_BYTE_LIMIT || createHash('sha256').update(readFileSync(file)).digest('hex') !== before) {
      throw new Error('changed_composition')
    }
    compositionFiles.push([file, before])
    compositionLayers.push(parsed)
  }
  for (const name of bundles) {
    const packageDir = boot.resolveBundleDir('dsh', name, anchor, profileDir)
    const bundle = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
    if (!bundle.dsh?.bundle) {
      throw new Error('unverifiable_bundle_resolution')
    }
    if (boot.evaluatePluginCompatibility(bundle, {}, manifest.version)) {
      skippedBundleEvidence.push({ name, path: join(packageDir, 'package.json'), digest: createHash('sha256').update(readFileSync(join(packageDir, 'package.json'))).digest('hex') })
      rootConfirmed = false
      continue
    }
    loaded.layers.push({ packageName: name, packageDir })
    const declaredFiles = bundle.dsh.bundle.patch
    for (const relativeFile of typeof declaredFiles === 'string' ? [declaredFiles] : declaredFiles || []) {
      const file = resolve(packageDir, relativeFile)
      const local = relative(packageDir, file)
      if (isAbsolute(local) || local.split(sep).includes('..')) {
        throw new Error('external_bundle_patch')
      }
      loadComposition(file)
    }
    if (rootConfirmed) {
      const declared = bundle.dsh.bundle.patch
      const paths = typeof declared === 'string' ? [declared] : declared
      if (!Array.isArray(paths) || !paths.length || paths.some(path => typeof path !== 'string')) {
        throw new Error('unverifiable_bundle_patches')
      }
      const patches = paths.map(path => {
        const filename = resolve(packageDir, path)
        const local = relative(packageDir, filename)
        if (isAbsolute(local) || local.split(sep).includes('..')) {
          throw new Error('external_bundle_patch')
        }
        return readFileSync(filename, 'utf8')
      })
      const patch = patches.join('\n')
      bundleDigests.push([packageDir, createHash('sha256').update(JSON.stringify([bundle, paths, patches])).digest('hex')])
      telemetryDeclarations += (patch.match(/id: desktop-product-telemetry/g) || []).length
      if (/cordis:include|cordis-plugin-include/.test(patch)) {
        rootConfirmed = false
      }
      if (name === '@deepseek-ai/dsh-web-app') {
        const telemetryRows = [...patch.matchAll(/^    - id: desktop-product-telemetry\r?\n([\s\S]*?)(?=^    - id:|$(?![\s\S]))/gm)]
        telemetryConfirmed = telemetryRows.length === 1
          && /^      name: ['"]@deepseek-ai\/dsh-host-product-telemetry-otel['"]\r?$/m.test(telemetryRows[0][1])
          && /^        serviceVersion: !!js process\.env\.DSH_CLIENT_VERSION\r?$/m.test(telemetryRows[0][1])
          && (patch.match(/id: desktop-product-telemetry/g) || []).length === 1
        if (telemetryConfirmed) {
          const sourceIndex = patches.findIndex(text => /id: desktop-product-telemetry/.test(text))
          telemetrySource = { rowId: 'desktop-product-telemetry', component: '@deepseek-ai/dsh-host-product-telemetry-otel', path: resolve(packageDir, paths[sourceIndex]), field: 'serviceVersion', variable: 'DSH_CLIENT_VERSION' }
        }
        const analyticsRows = [...patch.matchAll(/^    - id: product-analytics\r?\n([\s\S]*?)(?=^    - id:|$(?![\s\S]))/gm)]
        optionalRowsConfirmed = telemetryConfirmed && analyticsRows.length === 1
          && /^      name: ['"]@deepseek-ai\/dsh-client-product-analytics['"]\r?$/m.test(analyticsRows[0][1])
          && !/required:/.test(telemetryRows[0][1] + analyticsRows[0][1])
      }
    }
  }
  for (const patchPath of [join(profileDir, 'cordis.patch.yml'), join(home, 'cordis.patch.yml')]) {
    if (existsSync(patchPath)) {
      const bytes = readFileSync(patchPath)
      if (patchPath === join(profileDir, 'cordis.patch.yml') && acceptedPatchDigest && createHash('sha256').update(bytes).digest('hex') === acceptedPatchDigest) {
        continue
      }
      const patch = bytes.toString('utf8').split(/\r?\n/).filter(line => !/^\s*#/.test(line)).join('').trim()
      if (patch !== '' && patch !== '[]') {
        rootConfirmed = false
      }
    }
  }
  telemetryConfirmed = telemetryConfirmed && rootConfirmed && telemetryDeclarations === 1
  const rootFile = join(profileDir, 'cordis.yml')
  const rootText = existsSync(rootFile) ? readFileSync(rootFile, 'utf8') : null
  const rootDigest = rootText === null ? null : createHash('sha256').update(rootText).digest('hex')
  const emptyRoot = rootText !== null && rootText.split(/\r?\n/).filter(line => !/^\s*#/.test(line)).join('').trim() === '[]'
  for (const file of [join(profileDir, 'cordis.patch.yml'), join(home, 'cordis.patch.yml')]) {
    if (existsSync(file)) {
      loadComposition(file)
    }
  }
  const composed = boot.composeEntries(compositionLayers)
  let configurationEvidence = []
  try {
    const yaml = await import(pathToFileURL(join(runtime, 'yaml/dist/index.js')))
    configurationEvidence = configurationSources({
      observed: runtimeEvidence?.rows, composed, layers: compositionLayers, files: compositionFiles,
      compose: boot.composeEntries, digest: optionsDigest, emptyRoot,
      locate(writer, field) {
        const bytes = readFileSync(writer.path)
        if (createHash('sha256').update(bytes).digest('hex') !== compositionFiles.find(item => item[0] === writer.path)?.[1]) {
          throw new Error('changed_configuration_source')
        }
        const text = bytes.toString('utf8')
        const document = yaml.parseDocument(text, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => ({ __jsExpr: value }) }] })
        if (document.errors.length) {
          return null
        }
        const prefix = writer.insertIndex < 0 ? [writer.patchIndex, 'config'] : [writer.patchIndex, 'insert', writer.insertIndex, 'config']
        const node = document.getIn([...prefix, ...field.split('.')], true)
        const fallback = document.getIn(prefix, true)
        const offset = node?.range?.[0] ?? fallback?.range?.[0]
        return { line: typeof offset === 'number' ? text.slice(0, offset).split(/\r?\n/).length : null, fieldDeclared: Boolean(node) }
      },
    })
  } catch {
    configurationEvidence = (runtimeEvidence?.rows || []).filter(row => row.configuration).map(row => ({ rowId: row.id, component: row.component, field: row.configuration.field, confirmed: false, reason: '配置合成或字段来源读取失败，未推测来源。' }))
  }
  rootConfirmed = rootConfirmed && rootText !== null && rootText.split(/\r?\n/).filter(line => !/^\s*#/.test(line)).join('').trim() === '[]'
  telemetryConfirmed = telemetryConfirmed && rootConfirmed
  optionalRowsConfirmed = optionalRowsConfirmed && rootConfirmed
  const resolution = await boot.createRuntimeResolution({ installAnchor: anchor, profile: loaded, home })
  const service = new boot.PluginPackages(new Context(), { resolution })
  const rows = []
  const disableCandidates = []
  const introducers = []
  let dependencyDigest = null
  let dependencyReason = ''
  let optionalProof = { allowed: false, reason: '当前官方构建或依赖来源未核实' }
  try {
    // 官方 runProfile 将 profile/cordis.yml 传入 boot，Loader 的根解析基点就是该目录。
    const parent = pathToFileURL(join(profileDir, 'cordis.yml')).href
    for (const observed of runtimeEvidence?.rows || []) {
      if (observed.state !== 'failed') {
        continue
      }
      const proof = observed.fatalImport ? 'runtime-import-leaf' : 'runtime-schema-leaf'
      let reason = observed.fatalImport ? importDisableReason(observed, runtimeEvidence) : schemaDisableReason(observed, runtimeEvidence)
      let contentDigest = null
      const matching = composed.filter(row => row.id === observed.id && row.name === observed.component)
      const actual = service.packageOf(observed.component, observed.base)
      let sourceConfirmed = false
      let sourceReason = ''
      if (!emptyRoot || matching.length !== 1 || observed.base !== pathToFileURL(profileDir).href + '/') {
        sourceReason = '未确认唯一顶层配置条目，不能安全写入禁用补丁。'
      } else {
        try {
          if (optionsDigest(matching[0]) !== observed.optionsDigest || !actual || actual.dir !== observed.selected?.dir || actual.version !== observed.selected?.version || actual.name !== observed.component) {
            sourceReason = '当前有效配置或实际加载来源与启动证据不同。'
          } else {
            contentDigest = packageFingerprint(actual.dir)
            sourceConfirmed = contentDigest === observed.selected?.contentDigest
            if (!sourceConfirmed) {
              sourceReason = '实际插件文件在启动后发生变化。'
            }
          }
        } catch {
          sourceReason = '实际插件内容或有效配置无法安全核实。'
        }
      }
      if (!reason) {
        reason = sourceReason
      }
      disableCandidates.push({ id: observed.id, component: observed.component, proof, source: actual?.dir || null, version: actual?.version || null, optionsDigest: observed.optionsDigest, contentDigest, sourceConfirmed, disabledReason: reason, required: observed.required })
    }
    if (optionalRowsConfirmed && telemetryConfirmed) {
      try {
        optionalProof = optionalAnalyticsProof(runtime)
        for (const entry of resolution.entries) {
          if (!entry.name.startsWith('@deepseek-ai/') || entry.scope !== 'installation') {
            continue
          }
          const actual = service.packageOf(entry.name, parent)
          if (!actual || (actual.dir !== entry.packageDir && packageFingerprint(actual.dir) !== REVIEWED_LOCAL_OVERRIDES[entry.name])) {
            optionalProof.allowed = false
            optionalProof.reason = '存在未核实的本地实现或依赖来源'
          }
        }
      } catch (error) {
        optionalProof = { allowed: false, reason: String(error.message || error) }
      }
    }
    for (const name of names) {
      const selected = service.packageOf(name, parent)
      const entries = resolution.entries.filter(entry => entry.name === name)
      const replacement = entries.length === 1 && entries[0].scope === 'installation' ? entries[0] : null
      const replacementManifest = replacement ? JSON.parse(readFileSync(join(replacement.packageDir, 'package.json'), 'utf8')) : null
      rows.push({
        name,
        selected: selected ? { dir: selected.dir, version: selected.version, name: selected.name } : null,
        incompatible: selected ? Boolean(boot.evaluatePluginCompatibility(selected.manifest, {}, manifest.version)) : false,
        replacement: replacement && replacementManifest.name === name ? {
          dir: replacement.packageDir,
          version: replacementManifest.version,
          compatible: !boot.evaluatePluginCompatibility(replacementManifest, {}, manifest.version),
          declarer: replacement.declarer,
        } : null,
        declaredLocally: ['dependencies', 'peerDependencies', 'devDependencies', 'optionalDependencies'].some(field => Object.hasOwn(profileManifest[field] || {}, name)),
      })
    }
    if (rows.length) {
      try {
        const yaml = await import(pathToFileURL(join(runtime, 'yaml/dist/index.js')))
        const state = installedPackageState(profileDir)
        const { default: semver } = await import(pathToFileURL(join(runtime, 'semver/index.js')))
        const satisfiesRange = (version, requirement) => Boolean(semver.validRange(requirement)) && semver.satisfies(version, requirement)
        dependencyDigest = state.digest
        dependencyDigest += packageFingerprint(join(runtime, 'semver'))
        const bootFile = join(runtime, '@deepseek-ai/dsh-app-boot/lib/index.js')
        const bootText = readFileSync(bootFile, 'utf8')
        const requiredText = /const requiredStartupEntryIds = new Set\((\[[\s\S]*?\])\);/.exec(bootText)?.[1]
        if (!requiredText) {
          throw new Error('当前官方启动必需条目策略尚未核实。')
        }
        const requiredIds = new Set(JSON.parse(requiredText))
        dependencyDigest += createHash('sha256').update(bootText).digest('hex')
        const configurationComplete = emptyRoot && !composed.some(entry => typeof entry.name !== 'string' || /(?:cordis:include|cordis-plugin-include)/.test(entry.name))
        const resolveDependency = (name, directory) => service.packageOf(name, pathToFileURL(join(directory, 'package.json')).href)
        for (const row of rows) {
          const owners = dependencyOrigins(state, profileDir, row, resolveDependency, yaml.parse)
          row.dependencyOwners = owners
          row.configurationConfirmed = configurationComplete && composed.filter(entry => entry.name === row.name).length === 1
          row.configurationRowIds = composed.filter(entry => entry.name === row.name).map(entry => entry.id)
          for (const owner of owners.filter(entry => entry.direct && entry.field !== 'peerDependencies')) {
            const entries = composed.filter(entry => entry.name === owner.name).map(entry => ({ ...entry, required: requiredIds.has(entry.id) || entry.required === true }))
            const consumers = dependencyOrigins(state, profileDir, { name: owner.name, selected: { dir: owner.dir, version: owner.version } }, resolveDependency, yaml.parse)
            const removal = dependencyRemovalScope(state, owner, resolveDependency, { platform: process.platform, arch: process.arch }, satisfiesRange)
            dependencyDigest += createHash('sha256').update(JSON.stringify(removal.platformEvidence)).digest('hex')
            const removedDirectories = removal.predicted.map(item => item.dir)
            let disabledReason = assessIntroducer({ owner, owners, entries, removedDirectories, sourceConfirmed: row.configurationConfirmed, graphComplete: removal.complete === true, fallbackConfirmed: Boolean(row.incompatible && row.replacement?.compatible && !row.declaredLocally) })
            if (!disabledReason && consumers.some(item => item.installed !== true || !removedDirectories.includes(item.dir))) {
              disabledReason = '其他已安装组件还依赖此引入者，不能单独卸载。'
            }
            const affected = []
            if (!disabledReason && removal.retainedByOtherRoot) {
              disabledReason = '其他直接安装项仍需要此引入者，不能通过卸载解除冲突。'
            }
            for (const entry of composed.filter(item => item.disabled !== true)) {
              const actual = service.packageOf(entry.name, parent)
              if (!actual || !removal.predicted.some(item => item.dir === actual.dir)) {
                continue
              }
              const replacement = resolution.entries.filter(item => item.name === actual.name && item.scope === 'installation')
              const replacementManifest = replacement.length === 1 ? JSON.parse(readFileSync(join(replacement[0].packageDir, 'package.json'), 'utf8')) : null
              const compatible = Boolean(replacementManifest && replacementManifest.name === actual.name && compatibleUpgrade(actual.version, replacementManifest.version) && !boot.evaluatePluginCompatibility(replacementManifest, {}, manifest.version))
              affected.push({ id: entry.id, component: actual.name, required: requiredIds.has(entry.id), source: actual.dir, sourceDigest: packageFingerprint(actual.dir), replacement: compatible ? replacement[0].packageDir : null, replacementDigest: compatible ? packageFingerprint(replacement[0].packageDir) : null })
              if (!disabledReason && !compatible) {
                disabledReason = `预计影响启用条目 ${entry.id}，尚未核实其兼容替代。`
              }
            }
            const contentDigest = packageFingerprint(owner.dir)
            introducers.push({ component: row.name, owner, owners, consumers, affected, predicted: removal.predicted, entries: entries.map(entry => ({ id: entry.id, name: entry.name, disabled: entry.disabled === true, required: entry.required === true })), contentDigest, disabledReason })
          }
        }
      } catch (error) {
        dependencyReason = String(error.message || error)
        introducers.length = 0
      }
    }
  } finally {
    service.interception.dispose()
    service.disposeWorkerResolution()
  }
  // 在不存在的 profile 位置复用同一官方 installation 表，验证移开本地遮蔽后的解析目标。
  const virtual = join(home, 'profiles', '.dsh-x-resolution-preview')
  const fallback = new boot.PluginPackages(new Context(), { resolution: { ...resolution, profileDir: virtual, localPackageNames: [], linkedRoots: [] } })
  try {
    for (const row of rows) {
      row.fallback = fallback.packageOf(row.name, pathToFileURL(join(virtual, 'cordis.yml')).href)?.dir || null
    }
    for (const candidate of introducers) {
      for (const affected of candidate.affected) {
        const actual = fallback.packageOf(affected.component, pathToFileURL(join(virtual, 'cordis.yml')).href)
        if (!candidate.disabledReason && actual?.dir !== affected.replacement) {
          candidate.disabledReason = `预计影响 ${affected.id}，移除本地包后的官方解析结果尚未核实。`
        }
      }
    }
  } finally {
    fallback.interception.dispose()
    fallback.disposeWorkerResolution()
  }
  const optionalDependencies = optionalProof.allowed ? [{ from: { id: 'product-analytics', component: '@deepseek-ai/dsh-client-product-analytics' }, to: { id: 'desktop-product-telemetry', component: '@deepseek-ai/dsh-host-product-telemetry-otel' }, service: 'productTelemetry', source: 'reviewed_official_build', fingerprint: optionalProof.fingerprint, dependencyRequired: true, consumerStartupRequired: false }] : []
  process.stdout.write(JSON.stringify({ configurationEvidence, runtimeVersion: manifest.version, rootConfirmed, telemetryConfirmed, telemetrySource: telemetryConfirmed ? telemetrySource : null, optionalProof, optionalDependencies, rootDigest, bundleDigests, rows, disableCandidates, compositionFiles, introducers, dependencyDigest, dependencyReason, skippedBundleEvidence }))
}

main().catch(error => {
  process.stderr.write(String(error?.message || error))
  process.exitCode = 1
})
