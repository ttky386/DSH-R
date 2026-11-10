/*
MIT License

Copyright (c) 2026 Nexus contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

import { readRuntimeEvidence, RUNTIME_EVIDENCE_PREFIX } from './runtime-diagnostics.mjs'

// 纯解析来自 Nexus startup-diagnosis.mjs / compatibility.mjs。
// 不迁移探测进程、Canary 或恢复策略；原规则顺序由样例对拍约束。

/** 保留 Nexus 的分类优先级；多项问题由外层报告同时展示。 */
export function diagnoseStartup(text) {
  const rules = [
    ['nexus_integration', /A Nexus built-in plugin failed to load|failed to (?:import|apply) loader entry nexus-(?:desktop-compat|desktop-bridge|notifications)\b/i, 'Nexus integration failed to load', 'Repair or update the Nexus installation, then check startup again. Do not disable unrelated Harness plugins.'],
    ['storage_full', /ENOSPC|no space left on device/i, 'Startup could not write because the disk is full', 'Free space on the affected drive, then retry. Preserve Harness profiles and session data.'],
    ['cleanup_timeout', /Probe process cleanup timed out/i, 'The startup check could not finish stopping its process', 'Inspect the startup log and confirm the previous process has stopped before retrying.'],
    ['inputs_changed', /Source profile changed during compatibility check|Startup inputs changed after verification|Harness identity or entry changed after verification/i, 'Startup inputs changed during verification', 'Run the startup check again using the current configuration. No plugin change is required.'],
    ['process_lock', /(?:ledger|session|database).*(?:already owned by process|locked by|in use by another)/i, 'Another process owns this resource', 'Confirm whether the owning Harness process is still running. Stop that instance normally before retrying; do not delete lock files or disable unrelated plugins.'],
    ['port_conflict', /EADDRINUSE|address already in use/i, 'Listening port is occupied', 'Choose another port or stop the known application using it.'],
    ['permission', /EACCES|EPERM|permission denied/i, 'File or port access was denied', 'Check access to the named path or port and file locks; do not delete data to bypass the error.'],
    ['profile_restriction', /profile "desktop" is managed exclusively/, 'Profile reserved by Harness', 'Select a regular profile or a compatible Harness version.'],
    ['duplicate_entry', /duplicate loader entry id:\s*([\w.-]+)/i, 'Conflicting plugin entry ID', 'Inspect the declaring bundles and disable or adjust one conflicting third-party plugin.'],
    ['configuration', /failed to (?:read|parse) (?:profile manifest|config|patches|overlay)|must (?:be a top-level YAML array|hold a JSON object)|must be a mapping|YAMLException|JSONParseError|Desktop profile (?:manifest|JSON|bundles) (?:is|are) invalid/i, 'Invalid or unreadable configuration', 'Repair the named configuration or patch file; preserve a backup before editing.'],
    ['missing_bundle', /cannot resolve profile bundle ["']([^"']+)|profile bundle .+ declares no dsh\.bundle/i, 'Profile bundle is missing or invalid', 'Repair the selected profile dependencies or select a package that declares a Harness bundle.'],
    ['module_api', /cannot get property .+ without inject|cannot resolve ESM export|ERR_PACKAGE_PATH_NOT_EXPORTED|does not provide an export named|export .+ resolves outside its package|unsupported Node module loader|typert: .+ strict codec has no create\(\) factory/i, 'Package or runtime interface is incompatible', 'Use compatible plugin, Harness and Node versions; reinstalling the same incompatible version may not help.'],
    ['missing_module', /Cannot find (?:package|module)|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|main entry is missing|Installed dependency link is broken/i, 'Required module is missing', 'Use the importer path to locate the missing dependency in the Harness installation or profile. Check local package files and links before reinstalling; do not disable waiting plugins.'],
    ['module_layout', /exists and is not a (?:symlink or dsh-managed module proxy|dsh-managed module proxy)|profile resolution mismatch/i, 'Installed module layout conflicts with Harness', 'Stop Harness and repair the profile dependency installation. Preserve conflicting files before replacing them.'],
    ['restart_required', /profile resolution:.+requires a process restart/i, 'Dependency changes require a restart', 'Stop Harness completely and start it again to load the new dependency generation.'],
    ['patch_target', /cannot resolve entry [\w.-]+|entry [\w.-]+ is not a group/i, 'Patch refers to an unavailable entry', 'Update or disable the named patch for this Harness version; do not disable unrelated plugins.'],
    ['required_services', /Plugins waiting for services|pending \(waiting for services?:/i, 'Required services did not become available', 'Inspect the missing service names and their provider plugins; repair the provider rather than disabling the waiting consumer.'],
    ['plugin_activation', /required plugins? did not activate|disabled expression failed|failed to (?:import|apply) loader entry/i, 'Plugin activation failed', 'Inspect the reported package and its original cause before choosing a compatible version or disabling it.'],
    ['runtime_arguments', /invalid profile name|select a profile only once|error: --|unknown option|no invocation resolved/i, 'Harness launch arguments are invalid', 'Correct the profile or launch arguments for the selected Harness version.'],
    ['package_manifest', /installed package .+ must declare a non-empty version/i, 'Installed package metadata is invalid', 'Repair or replace the named package with a complete published version.'],
    ['process_exit', /Harness process exited before readiness/i, 'Harness exited before becoming ready', 'Inspect the exit status and startup log. An early exit alone does not identify a faulty plugin.'],
    ['readiness_timeout', /Compatibility (?:startup )?probe timed out/i, 'Harness did not become ready in time', 'Inspect the startup log and pending services; a timeout alone does not identify a faulty plugin.'],
  ];
  const rule = rules.find(([, pattern]) => pattern.test(text));
  const lines = text.split(/\r?\n/).map(line => line.trim());
  const evidence = lines.filter(line => line && !/^at |^file:\/\/\/|^throw |^\^|^\[cause\]:?$/.test(line));
  const diagnostic = rule
    ? { code: rule[0], summary: rule[2], remedy: rule[3], evidence: evidence.filter(line => rule[1].test(line)).slice(0, 4) }
    : { code: 'unknown', summary: 'Harness startup failed; cause not yet identified', remedy: 'Keep the original error and startup log. Do not disable plugins without evidence.', evidence: evidence.slice(0, 2) };
  diagnostic.evidence = diagnostic.evidence.map(line => line.slice(0, 1200));
  diagnostic.level = 'blocking';
  diagnostic.certainty = rule ? 'matched_signature' : 'unconfirmed';
  diagnostic.help = ['configuration', 'patch_target', 'runtime_arguments', 'permission', 'port_conflict'].includes(diagnostic.code) ? 'settings'
    : diagnostic.code === 'profile_restriction' ? 'profiles'
    : ['duplicate_entry', 'missing_bundle', 'module_api', 'missing_module', 'module_layout', 'package_manifest', 'plugin_activation', 'required_services'].includes(diagnostic.code) ? 'plugins'
    : 'logs';
  return diagnostic;
}

const ENTRY_LIMIT = 48
const SCAN_LIMIT = 400
const NAME_LIMIT = 240
const REASON_LIMIT = 400
const SERVICE_LIMIT = 32
const ENTRY_BYTES = 8000
const EVIDENCE_LINES = 400
const EVIDENCE_LINE_LENGTH = 4000
const EVIDENCE_CHARACTERS = 64000
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g

function bounded(value, limit) {
  let part = String(value).slice(0, limit)
  if (/[\uD800-\uDBFF]$/.test(part)) {
    part = part.slice(0, -1)
  }
  return new TextDecoder().decode(new TextEncoder().encode(part))
}

/** 只采信 Harness 明确的跳过记录，不把相邻日志归罪于插件。 */
export function parseSkippedBundles(text) {
  const entries = []
  let truncated = false
  let afterSkip = false
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = /^dsh(?: [\w-]+){0,3}: skipping profile bundle ("(?:[^"\\]|\\.)*"): (.+)$/.exec(line)
    if (!match) {
      if (line && afterSkip) {
        truncated = true
      }
      if (line) {
        afterSkip = false
      }
      continue
    }
    afterSkip = true
    let name
    try {
      name = JSON.parse(match[1])
    } catch {
      continue
    }
    if (entries.some(entry => entry.package === name && entry.reason === match[2])) {
      continue
    }
    if (entries.length >= ENTRY_LIMIT) {
      truncated = true
      continue
    }
    const entry = { package: bounded(name, NAME_LIMIT), reason: bounded(match[2], REASON_LIMIT) }
    if (entry.package !== name || entry.reason !== match[2]) {
      truncated = true
    }
    entries.push(entry)
  }
  while (new TextEncoder().encode(JSON.stringify(entries)).length > ENTRY_BYTES) {
    entries.pop()
    truncated = true
  }
  return { entries, truncated }
}

function latestActivationText(input) {
  const text = String(input || '')
  // 同一进程会输出多轮审计；未完成的新报告不能借用旧行、required 标记或原因。
  const reports = [...text.matchAll(/startup failed: \d+ required plugins? did not activate|(?:warning|required startup failure|web boot):\s*\d+\s+entr(?:y|ies) did not activate/gi)]
  return reports.length ? text.slice(reports.at(-1).index) : text
}

/** 复用 Nexus 激活解析；保留字段校验的嵌套缩进，堆栈不当作原因。 */
export function parseActivation(input) {
  let text = latestActivationText(input)
  let groupedTruncated = false
  const grouped = /startup failed: \d+ required plugins? did not activate/i.exec(text)
  if (grouped) {
    const rows = []
    const lines = text.slice(grouped.index + grouped[0].length).split(/\r?\n/)
    groupedTruncated = lines.length > SCAN_LIMIT
    let section
    let sectionLimit = 0
    let sectionRows = 0
    let entry
    const flush = () => {
      if (entry?.package) {
        rows.push(`${entry.id} (${entry.package}): ${entry.detail.join(' ').slice(0, REASON_LIMIT) || 'Plugin activation failed'}`)
      }
      entry = undefined
    }
    for (const raw of lines.slice(0, SCAN_LIMIT)) {
      const failedHeader = /^Failed plugins \((\d+)\):$/.exec(raw.trim())
      if (failedHeader) {
        flush()
        groupedTruncated ||= sectionRows < sectionLimit
        section = 'failed'
        sectionLimit = Number(failedHeader[1])
        sectionRows = 0
        continue
      }
      const pendingHeader = /^Plugins waiting for services \((\d+)\):$/.exec(raw.trim())
      if (pendingHeader) {
        flush()
        groupedTruncated ||= sectionRows < sectionLimit
        section = 'pending'
        sectionLimit = Number(pendingHeader[1])
        sectionRows = 0
        continue
      }
      if (section === 'failed') {
        const title = /^  (\S+)(?: \(required\))?\s*$/.exec(raw)
        if (title) {
          flush()
          if (sectionRows >= sectionLimit) {
            continue
          }
          sectionRows += 1
          entry = { id: title[1], detail: [] }
          continue
        }
        const pkg = /^    Package: (\S+)\s*$/.exec(raw)
        if (pkg && entry) {
          entry.package = pkg[1]
          continue
        }
        if (entry && /^    (?:\S|\s+- \$\.)/.test(raw) && !/^\s+at /.test(raw)) {
          entry.detail.push(raw.trim())
        }
      } else if (section === 'pending') {
        const pending = /^  (\S+)(?: \(required\))? {2,}(\S.*)$/.exec(raw)
        if (pending && pending[1] !== 'Plugin' && sectionRows < sectionLimit) {
          sectionRows += 1
          rows.push(`${pending[1]}: pending (waiting for services: ${pending[2].trim()})`)
        }
      }
    }
    flush()
    groupedTruncated ||= sectionRows < sectionLimit
    if (!rows.length) {
      return { entries: [], missing_services: [], truncated: true }
    }
    text = `dsh: required startup failure: ${rows.length} entries did not activate\n${rows.join('\n')}`
  }
  const header = /(?:warning|required startup failure|web boot):\s*(\d+)\s+entr(?:y|ies) did not activate/i.exec(text)
  if (!header) {
    return null
  }
  const entries = []
  let truncated = groupedTruncated
  const expectedEntries = Number(header[1])
  let scanned = 0
  for (const raw of text.slice(header.index + header[0].length).split(/\r?\n/)) {
    if (entries.length >= expectedEntries) {
      break
    }
    const line = raw.trim()
    if (!line || line.startsWith('at ') || /did not activate/i.test(line)) {
      continue
    }
    scanned += 1
    if (scanned > SCAN_LIMIT) {
      truncated = true
      break
    }
    const row = /^(\S+?)(?:\s+\(([^)]+)\))?:\s*(\S.*)$/.exec(line)
    if (!row) {
      continue
    }
    if (entries.length >= ENTRY_LIMIT) {
      truncated = true
      break
    }
    const waiting = /^pending \(waiting for services?:\s*([^)]*)\)$/i.exec(row[3])
    // 官方失败行带包名；旧版无包名格式只接受明确的 pending 语法。
    if (!row[2] && !waiting) {
      continue
    }
    const missing = waiting
      ? [...new Set(waiting[1].split(',').map(part => part.trim()).filter(part => part && part !== 'unknown'))]
      : []
    if (missing.length > SERVICE_LIMIT) {
      truncated = true
    }
    entries.push({
      id: row[1].slice(0, NAME_LIMIT),
      package: (row[2] || row[1]).slice(0, NAME_LIMIT),
      state: waiting ? 'pending' : 'failed',
      reason: row[3].slice(0, REASON_LIMIT),
      missing: missing.slice(0, SERVICE_LIMIT).map(service => service.slice(0, NAME_LIMIT)),
    })
  }
  if (!entries.length && expectedEntries === 0) {
    return null
  }
  truncated ||= entries.length < expectedEntries
  while (JSON.stringify(entries).length > ENTRY_BYTES && entries.length > 1) {
    entries.pop()
    truncated = true
  }
  const counts = new Map()
  for (const entry of entries) {
    for (const service of entry.missing) {
      counts.set(service, (counts.get(service) ?? 0) + 1)
    }
  }
  return { entries, missing_services: [...counts.keys()].sort((left, right) => counts.get(right) - counts.get(left)), truncated }
}

function normalizeLine(raw) {
  // 历史 manager.log 的两层包装；子进程原始输出不动缩进。
  return String(raw).replace(ANSI_RE, '').replace(/^\[\d{4}-\d\d-\d\dT[^\]]+\] \[[^\]]+\/[^\]]+\] ?/, '')
}

function rejectedRows(lines) {
  const rows = []
  const recognized = new Set()
  let truncated = false
  for (const line of lines) {
    const match = /^dsh: disabling profile plugin row ("(?:[^"\\]|\\.)*"): Plugin (\S+) is incompatible with dsh (\S+): requirements (.+?)(?:\. Running it|$)/.exec(line)
    if (!match) {
      continue
    }
    let id
    try {
      id = JSON.parse(match[1])
    } catch {
      continue
    }
    recognized.add(line)
    if (rows.some(row => row.id === id && row.package === match[2])) {
      continue
    }
    if (rows.length >= ENTRY_LIMIT) {
      truncated = true
      continue
    }
    const row = {
      id: bounded(id, NAME_LIMIT),
      package: bounded(match[2], NAME_LIMIT),
      runtime: bounded(match[3], NAME_LIMIT),
      requirements: bounded(match[4], REASON_LIMIT),
      source: 'unconfirmed',
    }
    truncated ||= row.id !== id || row.package !== match[2] || row.runtime !== match[3] || row.requirements !== match[4]
    rows.push(row)
  }
  return { rows, truncated, recognized }
}

/** 每次 spawn 一个收集器；仅保留有界证据，不参与重试、禁用或恢复决策。 */
export function createStartupDiagnosis(context = {}, sanitizeLine = value => value) {
  const evidence = []
  let characters = 0
  let lineNumber = 0
  let truncated = false
  let activationSection = false
  let runtimeEvidence = null
  return {
    addLine(raw) {
      if (raw.startsWith(RUNTIME_EVIDENCE_PREFIX)) {
        const snapshot = readRuntimeEvidence(raw, context.attemptId)
        if (snapshot) {
          runtimeEvidence = snapshot
          return true
        }
        return false
      }
      lineNumber += 1
      // 先脱敏再裁剪：否则完整秘密会被截成前缀，出站阶段无法匹配它。
      const line = sanitizeLine(normalizeLine(raw))
      if (/startup failed: \d+ required plugins? did not activate|(?:warning|required startup failure|web boot):\s*\d+\s+entr(?:y|ies) did not activate/i.test(line)) {
        activationSection = true
      }
      if (activationSection && line && !/^\s/.test(line) && !/^Failed plugins|^Plugins waiting|did not activate/.test(line) && !/^\S+(?:\s+\([^)]+\))?:\s/.test(line)) {
        activationSection = false
      }
      // 保留分类器能认识的行和完整激活分组；普通输出风暴不能挤掉关键证据。
      const meaningful = activationSection || /skipping profile bundle|disabling profile plugin row|(?:Error|Exception)\b|is not a function/.test(line) || diagnoseStartup(line).code !== 'unknown'
      if (!meaningful && evidence.length) {
        return false
      }
      const text = bounded(line, EVIDENCE_LINE_LENGTH)
      const wasTruncated = truncated
      if (text !== line) {
        truncated = true
      }
      if (evidence.length >= EVIDENCE_LINES || characters + text.length > EVIDENCE_CHARACTERS) {
        truncated = true
        return !wasTruncated
      }
      characters += text.length
      evidence.push({ line: lineNumber, text })
      return true
    },
    report() {
      const lines = evidence.map(item => item.text)
      const text = lines.join('\n')
      const rejection = rejectedRows(lines)
      // 已有明确拒绝归类的官方行，不再被宽泛激活格式误读为名叫 dsh 的失败插件。
      const activationText = latestActivationText(lines.filter(line => !rejection.recognized.has(line)).join('\n'))
      const activationLines = activationText.split('\n')
      const activation = parseActivation(activationText)
      // 保留原函数的冻结输出；增强字段只存在于展示报告，不影响 Nexus 对拍。
      const required = new Set(activationLines.flatMap(line => {
        const match = /^  (\S+) \(required\)(?:\s|$)/.exec(line)
        return match ? [match[1]] : []
      }))
      for (const entry of activation?.entries || []) {
        if (required.has(entry.id)) {
          entry.required = true
        }
        const start = activationLines.findIndex(line => line.trim().startsWith(`${entry.id} (`) || line.trim().startsWith(`${entry.id}:`))
        if (start >= 0 && entry.state === 'failed') {
          for (const detail of activationLines.slice(start + 1)) {
            if (!/^\s/.test(detail)) {
              break
            }
            if (/^\s+- \$\./.test(detail)) {
              entry.reason = bounded(`${entry.reason} ${detail.trim()}`, REASON_LIMIT)
            }
          }
        }
      }
      const failed = (activation?.entries || []).filter(entry => entry.state === 'failed')
      for (const row of runtimeEvidence?.rows || []) {
        if (row.fatalImport && row.state === 'failed' && !failed.some(entry => entry.id === row.id && entry.package === row.component)) {
          const fatalLine = lines.find(line => /dsh: fatal (?:load failure|uncaught exception):/.test(line))
          failed.push({ id: row.id, package: row.component, state: 'failed', required: row.required, reason: bounded(fatalLine || '导入错误触发官方致命退出；原始错误文本未采集。', REASON_LIMIT) })
        }
      }
      const waiting = (activation?.entries || []).filter(entry => entry.state === 'pending')
      const rejected = rejection.rows
      const blockingChains = waiting.filter(entry => entry.required).flatMap(entry => entry.missing.map(service => {
        const sameName = rejected.find(row => row.id === service)
        return {
          id: entry.id, service,
          ...(sameName ? { rejectedRow: { id: sameName.id, package: sameName.package } } : {}),
        }
      }))
      const skipped = parseSkippedBundles(text)
      const primary = diagnoseStartup(failed.length ? failed.map(entry => entry.reason).join('\n') : text)
      const advice = []
      if (failed.some(entry => entry.package === '@deepseek-ai/dsh-host-product-telemetry-otel' && /serviceVersion missing required value/.test(entry.reason))) {
        advice.push({ code: 'telemetry_configuration' })
      }
      if (rejected.length || skipped.entries.some(entry => /incompatible with dsh/.test(entry.reason))) {
        advice.push({ code: 'incompatible_packages' })
      }
      if (waiting.length) {
        advice.push({ code: 'waiting_services' })
      }
      if (lines.some(line => /is not a function/.test(line))) {
        advice.push({ code: 'module_interface' })
      }
      return {
        context: {
          version: context.version || '',
          profile: context.profile || '',
          entry: context.entry || '',
          harnessEntry: context.harnessEntry || '',
          clientVersionPresent: context.clientVersionPresent ?? null,
        },
        primary, failed, waiting, rejected, skipped, advice, blockingChains,
        ...(runtimeEvidence ? { runtimeEvidence } : {}),
        evidence: evidence.map(item => ({ ...item })),
        truncated: truncated || Boolean(activation?.truncated) || skipped.truncated || rejection.truncated,
      }
    },
  }
}
