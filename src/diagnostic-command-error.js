const MAX_INPUT_CHARS = 128 * 1024
const MAX_RESULT_CHARS = 12 * 1024
const MAX_LABEL_CHARS = 256
const MAX_FALLBACK_LINES = 8
const TRUNCATION_NOTICE = '\n（错误输出已截断；完整输出请查看本次启动器日志。）'

function cleanText(value) {
  return String(value || '')
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
}

function isNoise(line) {
  return /^Progress:|^\??\s*Verifying lockfile|plugin command failed; diagnostics:|^nothing was installed/i.test(line)
}

function isInstruction(line) {
  return /--accept-risk|\b(?:relax (?:the )?policy|allow-version|to accept (?:this|the) risk|pnpm (?:clean|install|config set))\b/i.test(line)
}

function isErrorHeading(line) {
  return /^(?:\[?ERR_PNPM_|dsh:\s*(?:error|installation rejected|failed|cannot|could not)|(?:[A-Za-z]*Error|EACCES|EPERM|ENOSPC|ECONNRESET|ETIMEDOUT|ENOTFOUND)\b)/i.test(line)
}

function uniqueErrorBlocks(lines) {
  const blocks = []
  let block = []
  for (const line of lines) {
    if (block.length && isErrorHeading(line)) {
      blocks.push(block.join('\n'))
      block = []
    }
    block.push(line)
  }
  if (block.length) {
    blocks.push(block.join('\n'))
  }
  // 相同原因可能分别属于不同包，只去完整重复错误块，绝不去掉块内续行。
  return [...new Set(blocks)].join('\n')
}

/** 诊断卸载只展示已脱敏的实际错误与续行，不生成绕过校验或修改环境的建议。 */
export function describeDiagnosticCommandFailure(output, label, code) {
  const raw = String(output || '')
  const text = cleanText(raw.slice(0, MAX_INPUT_CHARS))
  const lines = text.split(/\r\n|\n|\r/)
  const start = lines.findIndex(line => /ERR_PNPM_|\bdsh:\s*(?:error|installation rejected|failed|cannot|could not)|\b(?:Error|EACCES|EPERM|ENOSPC|ECONNRESET|ETIMEDOUT|ENOTFOUND)\b/i.test(line))
  const candidates = start >= 0 ? lines.slice(start) : lines.slice(-MAX_FALLBACK_LINES)
  const details = []
  for (const original of candidates) {
    const line = original.trimEnd()
    const identity = line.trim()
    if (!identity || isNoise(identity) || isInstruction(identity)) {
      continue
    }
    details.push(line)
  }
  const heading = cleanText(label).slice(0, MAX_LABEL_CHARS) || '诊断卸载'
  if (!details.length) {
    if (raw.length > MAX_INPUT_CHARS) {
      return `${heading} 失败（退出码 ${code}，保留片段中未找到具体原因）${TRUNCATION_NOTICE}`
    }
    return `${heading} 失败（退出码 ${code}，命令未提供具体原因；请查看本次启动器日志）`
  }
  const result = `${heading} 失败\n${uniqueErrorBlocks(details)}`
  if (raw.length > MAX_INPUT_CHARS || result.length > MAX_RESULT_CHARS) {
    return result.slice(0, MAX_RESULT_CHARS - TRUNCATION_NOTICE.length) + TRUNCATION_NOTICE
  }
  return result
}
