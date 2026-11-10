import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { listSkills } from '../src/skills.js'
import { mask } from '../skills/dsh-x-selfcheck/scripts/selfcheck.mjs'

// 这个 skill 是给 AI 用来「先看清环境」的，因此有两条不能退的底线在这里守着：
// 1. frontmatter 必须能被 dsh 真正的技能发现器（skills.js）认出来，否则装了等于没装；
// 2. 脚本必须保持只读 + 零依赖，不能把自检变成新的故障源。
// 用例默认不依赖管理页是否在跑：管理页不在时脚本要能降级跑完，只是发现项变少。

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SKILL_DIR = join(ROOT, 'skills', 'dsh-x-selfcheck')
const SCRIPT = join(SKILL_DIR, 'scripts', 'selfcheck.mjs')

function run(args, options = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: options.timeout || 60_000,
    env: process.env,
  })
}

/** 假管理页测试要在同进程里开 http server，spawnSync 会堵住事件循环，所以这里用异步版。 */
function runAsync(args, script = SCRIPT) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: ROOT, env: process.env, timeout: 60_000 })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => resolvePromise({ status: 3, stdout, stderr: String(error) }))
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }))
  })
}

/** 占住动态端口并返回非管理页响应，不能把宿主服务当作测试环境。 */
async function runWithoutManager(args, script = SCRIPT) {
  const server = createServer((request, response) => {
    response.writeHead(404)
    response.end('isolated selfcheck fixture')
  })
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  try {
    return await runAsync([...args, '--port', String(server.address().port)], script)
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose))
  }
}

function jsonReply(response, value) {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}

test('SKILL.md 的 frontmatter 能被 dsh 技能发现器接受', () => {
  const skills = listSkills([{ key: 'repo', dir: join(ROOT, 'skills') }])
  const self = skills.find((item) => item.name === 'dsh-x-selfcheck')
  assert.ok(self, 'skills/dsh-x-selfcheck/SKILL.md 应该作为一个技能被发现')
  assert.equal(self.frontmatterOk, true, self.frontmatterIssue)
  assert.equal(self.dirName, 'dsh-x-selfcheck')
  assert.ok(self.description.length > 20, 'description 要能让 AI 判断何时调用')
})

test('脚本零第三方依赖，且不写文件（只读承诺）', () => {
  const source = readFileSync(SCRIPT, 'utf8')
  const imports = [...source.matchAll(/^\s*import\s[^'\n]*from\s+['"]([^'"]+)['"]/gm)].map((match) => match[1])
  assert.ok(imports.length > 0)
  for (const specifier of imports) {
    assert.ok(specifier.startsWith('node:') || specifier.startsWith('.'), `不允许第三方依赖：${specifier}`)
  }
  const writes = [
    'writeFileSync',
    'writeFile(',
    'appendFileSync',
    'openSync(',
    'createWriteStream',
    'rmSync',
    'rm(',
    'unlinkSync',
    'renameSync',
    'mkdirSync',
    'copyFileSync',
    'cp(',
    'chmodSync',
    'symlinkSync',
    'linkSync',
    'truncateSync',
    'utimesSync',
    'spawn(',
    'spawnSync',
    'execSync',
    'execFileSync',
  ]
  for (const name of writes) {
    assert.equal(source.includes(name), false, `自检脚本不应该调用 ${name}`)
  }
})

test('mask 能掩盖常见凭据形态（含 AWS / camelCase 配置键）', () => {
  const secrets = [
    'AKIAIOSFODNN7EXAMPLE',
    'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    'FwoGZXIvYXdzEBYaDEXAMPLETOKEN',
    'abc123def456',
    'abcdef123456',
    'dXNlcjpwYXNzd29yZA==',
    'hunter2hunter2',
    'eyJhbGciOiJIUzI1NiJ9.payload.sig',
    'sk-abcdef1234567890abcdef',
    'ak-abcdef1234567890abcdef',
    'user:pass@example.com',
  ]
  const samples = [
    'secretAccessKey=AKIAIOSFODNN7EXAMPLE',
    'accessKeyId=AKIAIOSFODNN7EXAMPLE',
    'aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    'sessionToken=FwoGZXIvYXdzEBYaDEXAMPLETOKEN',
    'token=abc123def456',
    'password="hunter2hunter2"',
    'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig',
    'Authorization: Basic dXNlcjpwYXNzd29yZA==',
    'refresh_token=abc123def456',
    'Cookie: session=abcdef123456',
    'secretKey=abcdef123456',
    'secret_key=abcdef123456',
    'accessKeySecret=abcdef123456',
    'sk-abcdef1234567890abcdef',
    'ak-abcdef1234567890abcdef',
    'https://user:pass@example.com/path',
  ]
  for (const sample of samples) {
    const masked = mask(sample)
    assert.notEqual(masked, sample, `应该改写：${sample}`)
    for (const secret of secrets) {
      if (!sample.includes(secret)) continue
      assert.equal(masked.includes(secret), false, `泄漏了 ${secret}（${sample} → ${masked}）`)
    }
  }
  assert.equal(mask(''), '')
  assert.equal(mask(null), '')
})

test('--help 正常退出并包含关键选项', () => {
  const result = run(['--help'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /--json/)
  assert.match(result.stdout, /--no-logs/)
  assert.match(result.stdout, /退出码|exit/i)
})

test('不认识参数时按「脚本自身出错」退出（3），不静默吞掉', () => {
  const result = run(['--definitely-not-a-flag'])
  assert.equal(result.status, 3)
  assert.match(result.stderr, /不认识的参数/)
})

test('--json 输出结构稳定，summary 计数与退出码自洽', async () => {
  const result = await runWithoutManager(['--json', '--no-logs'])
  assert.notEqual(result.status, 3, result.stderr)
  const data = JSON.parse(result.stdout)
  assert.equal(data.tool, 'dsh-x-selfcheck')
  assert.equal(data.schema, 1)
  assert.ok(Array.isArray(data.checks) && data.checks.length > 0)
  assert.ok(data.target && typeof data.target === 'object')
  assert.deepEqual(
    Object.keys(data.target).sort(),
    ['dataDir', 'dataDirSource', 'dshHome', 'dshHomeSource', 'installDir', 'logsSource', 'managerFound', 'managerUrl', 'managerVersion', 'profile'],
    'target 的字段是 AI 写修复建议时的事实来源，不能悄悄变',
  )
  assert.ok(data.summary && typeof data.summary === 'object')
  for (const check of data.checks) {
    assert.ok(check.id, '每条检查都要有 id')
    assert.ok(check.section, '每条检查都要有分区')
    assert.ok(['ok', 'info', 'warn', 'fail'].includes(check.status), check.status)
    assert.ok(check.title, '每条检查都要有标题')
  }
  const counts = { ok: 0, info: 0, warn: 0, fail: 0 }
  for (const check of data.checks) counts[check.status] += 1
  assert.deepEqual(
    { ok: data.summary.ok, info: data.summary.info, warn: data.summary.warn, fail: data.summary.fail },
    counts,
  )
  const expectedExit = counts.fail ? 2 : counts.warn ? 1 : 0
  assert.equal(data.summary.exitCode, expectedExit)
  assert.equal(result.status, expectedExit, '进程退出码要和 JSON 里报告的一致')
})

test('--json 不泄露凭据形态的字符串', async () => {
  const result = await runWithoutManager(['--json', '--no-logs'])
  assert.notEqual(result.status, 3, result.stderr)
  const text = result.stdout
  assert.doesNotMatch(text, /sk-[A-Za-z0-9_-]{16,}/, '疑似 API key 泄漏')
  assert.doesNotMatch(text, /ak-[A-Za-z0-9_-]{16,}/, '疑似 AccessKey 泄漏')
  assert.doesNotMatch(text, /secretAccessKey\s*[:=]\s*["'][^"']{4,}/i)
  assert.doesNotMatch(text, /["']?(?:password|secret)\s*[:=]\s*["'][^"']{8,}/i)
})

test('目标不是管理页时给降级报告（独占动态端口）', async () => {
  const result = await runWithoutManager(['--json', '--no-logs'])
  assert.notEqual(result.status, 3, result.stderr)
  const data = JSON.parse(result.stdout)
  assert.equal(data.target.managerFound, false)
  assert.ok(data.checks.length > 0)
})

test('人类报告有标题、分区和退出码说明', async () => {
  const result = await runWithoutManager(['--no-logs'])
  assert.notEqual(result.status, 3, result.stderr)
  assert.match(result.stdout, /DSH-X 环境自检/)
  assert.match(result.stdout, /退出码/)
  assert.match(result.stdout, /(正常|提示|警告|失败)\s+\d+/)
})

test('管理页在跑但 /api/state 失败时，不把实例状态误报成「管理页没在跑」', async () => {
  let port = 0
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://127.0.0.1').pathname
    if (path === '/api/ping') return jsonReply(response, { app: 'dsh-x', version: '0.1.17', port })
    if (path === '/api/state') {
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end('{"error":"boom"}')
      return
    }
    if (path === '/api/self') return jsonReply(response, { current: '0.1.17', latest: '0.1.17', update: false })
    if (path === '/api/plugins') return jsonReply(response, { profile: 'web', plugins: [], disables: [] })
    if (path === '/api/skills') {
      return jsonReply(response, { skills: [], roots: [], localSkills: { enabled: true, rows: [], legacy: false }, profile: 'web' })
    }
    if (path === '/api/sync') return jsonReply(response, { store: 's3', configured: false, missing: [], remoteUrl: '', state: null, running: false })
    response.writeHead(404)
    response.end()
  })
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  port = server.address().port
  try {
    const result = await runAsync(['--json', '--no-logs', '--port', String(port)])
    assert.notEqual(result.status, 3, result.stderr)
    const data = JSON.parse(result.stdout)
    assert.equal(data.target.managerFound, true)
    const stateError = data.checks.find((check) => check.id === 'state-error')
    assert.ok(stateError, '应该有一条 state-error 警告')
    assert.equal(stateError.status, 'warn')
    const instanceUnknown = data.checks.find((check) => check.id === 'instances-unknown')
    assert.ok(instanceUnknown, '应该有一条实例状态说明')
    assert.equal(instanceUnknown.status, 'warn')
    assert.match(instanceUnknown.detail || '', /api\/state 读不到/, '要说明是状态接口失败，不是管理页没跑')
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose))
  }
})

test('从 junction/symlink 路径运行也能正常执行（安装后的实际调用方式）', async () => {
  // Node 的 ESM 入口按 realpath 解析，经链接启动时 argv[1] 是链接路径、import.meta.url 是真实路径。
  // 主守卫必须比较 realpath，否则 SKILL.md 推荐的 junction 安装会静默 exit 0、零输出。
  const temp = mkdtempSync(join(tmpdir(), 'dsh-selfcheck-link-'))
  const link = join(temp, 'dsh-x-selfcheck')
  try {
    symlinkSync(SKILL_DIR, link, process.platform === 'win32' ? 'junction' : 'dir')
    const linkedScript = join(link, 'scripts', 'selfcheck.mjs')
    const help = spawnSync(process.execPath, [linkedScript, '--help'], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 })
    assert.equal(help.status, 0, help.stderr)
    assert.ok(help.stdout.length > 100, '经链接运行时 main() 必须真的执行，不能静默 exit 0')
    assert.match(help.stdout, /--json/)
    const json = await runWithoutManager(['--json', '--no-logs'], linkedScript)
    assert.notEqual(json.status, 3, json.stderr)
    const data = JSON.parse(json.stdout)
    assert.equal(data.tool, 'dsh-x-selfcheck')
    assert.equal(data.target.managerFound, false)
  } finally {
    try {
      unlinkSync(link)
    } catch {
      /* junction 已不在时忽略 */
    }
    try {
      rmSync(temp, { recursive: true, force: true })
    } catch {
      /* 尽力清理临时目录 */
    }
  }
})
