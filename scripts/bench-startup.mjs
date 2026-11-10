/**
 * 管理器启动与日志压力基准；默认使用假 dsh，不接触用户 Profile。
 * node scripts/bench-startup.mjs --runs=3 --lines=3000 --output=<结果.json>
 * --version=<已装版本> 使用真实内核和全新临时 Profile；--server-root=<目录> 对比另一份源码。
 * --compare-root=<旧源码目录> 交替运行旧版与当前版，减少文件缓存和机器负载的偏差。
 * 测的是启动器开销，不代表真实内核、插件和 WebView 首屏耗时。
 */
import { fork } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const script = fileURLToPath(import.meta.url)
const root = dirname(dirname(script))
const option = (name, fallback) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
const lines = Number(option('lines', 3000))
const runs = Number(option('runs', 3))
const realVersion = option('version', '')
if (realVersion && !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(realVersion)) throw new Error('非法内核版本')
const version = realVersion || '9.9.9'
// 源码目录现在把运行时放在 src/；旧 checkout / 已装核心还是平铺的，两种都认
const coreRoot = (dir) => (existsSync(join(dir, 'server.js')) ? dir : join(dir, 'src'))
const serverRoot = coreRoot(option('server-root', root))
const compareRoot = option('compare-root', '')
if (!Number.isInteger(lines) || lines < 0 || lines > 100000 || !Number.isInteger(runs) || runs < 1 || runs > 20) throw new Error('lines: 0-100000; runs: 1-20')

if (process.argv.includes('--worker')) {
  const temp = mkdtempSync(join(tmpdir(), 'dsh-startup-bench-'))
  process.env.HOME = temp
  process.env.USERPROFILE = temp
  process.env.APPDATA = temp
  process.env.XDG_CONFIG_HOME = temp
  process.env.DSH_VERSIONS_DATA = join(temp, 'data')
  const app = process.platform === 'darwin'
    ? join(temp, 'Library', 'Application Support', 'DSH')
    : process.platform === 'linux' ? join(temp, 'DSH') : join(temp, 'DSH')
  const data = join(temp, 'data'), home = join(temp, 'home'), marker = join(temp, 'ready-at')
  const versionDir = join(data, 'versions', version)
  const binary = join(versionDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib')
  mkdirSync(app, { recursive: true })
  if (realVersion) {
    const installed = join(root, 'data', 'versions', realVersion)
    if (!existsSync(join(installed, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))) throw new Error(`内核未安装：${installed}`)
    mkdirSync(versionDir, { recursive: true })
    symlinkSync(join(installed, 'node_modules'), join(versionDir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  } else mkdirSync(binary, { recursive: true })
  mkdirSync(home, { recursive: true })
  writeFileSync(join(data, 'config.json'), JSON.stringify({ versions: [version] }))
  writeFileSync(join(app, 'settings.json'), JSON.stringify({ dataDir: data, dshHome: home, seedMarket: false, proxyMode: 'off', downloadSource: 'official' }))
  if (!realVersion) writeFileSync(join(binary, 'bin.js'), `
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
const at = process.argv.indexOf('--port')
const server = createServer((req, res) => res.end('<!doctype html><body>benchmark</body>'))
server.listen(at < 0 ? 0 : Number(process.argv[at + 1]), '127.0.0.1', () => {
  const batch = Array.from({ length: ${lines} }, (_, index) => 'bench-line-' + index + ' ' + 'x'.repeat(160) + '\\n').join('')
  process.stdout.write(batch, () => {
    writeFileSync(${JSON.stringify(marker)}, String(Date.now()))
    console.log('dsh web: http://127.0.0.1:' + server.address().port + '/?token=benchmark')
  })
})
`)
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  process.env.PORT = String(probe.address().port)
  await new Promise((resolve) => probe.close(resolve))
  let stopAll
  try {
    const managerStart = performance.now()
    const server = await import(pathToFileURL(join(serverRoot, 'server.js')).href)
    stopAll = server.stopAll
    const origin = await server.startServer()
    const managerMs = performance.now() - managerStart
    let maxLagMs = 0, expected = performance.now() + 5
    const timer = setInterval(() => {
      const now = performance.now()
      maxLagMs = Math.max(maxLagMs, now - expected)
      expected = now + 5
    }, 5)
    const started = performance.now()
    const response = await fetch(origin + '/api/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version, profile: 'web' }), signal: AbortSignal.timeout(60000) })
    const result = await response.json()
    const apiMs = performance.now() - started
    const readyTailMs = realVersion ? null : Date.now() - Number(readFileSync(marker, 'utf8'))
    clearInterval(timer)
    if (!response.ok || !result.url) throw new Error(JSON.stringify(result))
    const logs = await (await fetch(origin + '/api/logs/export')).text()
    const recordedLines = [...logs.matchAll(/bench-line-\d+/g)].length
    let pageStatus = null
    if (realVersion) {
      const first = await fetch(result.url, { redirect: 'manual', signal: AbortSignal.timeout(30000) })
      const location = first.headers.get('location')
      const cookie = (first.headers.getSetCookie?.() || []).map((value) => value.split(';')[0]).join('; ')
      const page = location ? await fetch(new URL(location, result.url), { headers: { cookie }, signal: AbortSignal.timeout(30000) }) : first
      pageStatus = page.status
      await page.arrayBuffer()
    }
    const completedLogs = realVersion ? await (await fetch(origin + '/api/logs/export')).text() : logs
    process.send({ lines, managerMs, apiMs, readyTailMs, maxLagMs, recordedLines, version, pageStatus,
      perf: completedLogs.split('\n').filter((line) => line.includes('[perf]')).map((line) => line.slice(line.indexOf('[perf]'))),
      timing: logs.split('\n').filter((line) => line.includes('启动耗时')).map((line) => line.slice(line.indexOf('启动耗时'))) })
    await fetch(origin + '/api/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  } finally {
    await stopAll?.()
    // Windows 的子进程 cwd 可能刚刚释放；基准结果不能被临时目录清理的时序覆盖。
    try { rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch {}
  }
  process.exit(0)
} else {
  const samples = []
  for (let index = 0; index < runs; index++) {
    for (const count of realVersion ? [0] : [...new Set([0, lines])]) {
      const sources = compareRoot ? [['baseline', compareRoot], ['working', serverRoot]] : [['working', serverRoot]]
      // 交换每轮先后顺序，避免新代码总是吃到旧代码刚读热的文件缓存。
      if (index % 2) sources.reverse()
      for (const [source, currentRoot] of sources) {
        const result = await new Promise((resolve, reject) => {
          const child = fork(script, ['--worker', `--lines=${count}`, `--server-root=${currentRoot}`, ...(realVersion ? [`--version=${realVersion}`] : [])], { cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
          let result, errors = ''
          child.stderr.on('data', (chunk) => { errors = (errors + chunk).slice(-8000) })
          child.on('message', (message) => { result = message })
          child.once('error', reject)
          child.once('exit', (code) => code === 0 && result ? resolve(result) : reject(new Error(errors || `benchmark exit ${code}`)))
        })
        samples.push({ source, ...result })
        console.log(JSON.stringify({ source, ...result }))
      }
    }
  }
  const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b)
    return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2
  }
  const summary = [...new Set(samples.map((sample) => `${sample.source}:${sample.lines}`))].map((id) => {
    const group = samples.filter((sample) => `${sample.source}:${sample.lines}` === id)
    return { source: group[0].source, lines: group[0].lines, ...Object.fromEntries(['managerMs', 'apiMs', 'readyTailMs', 'maxLagMs'].map((key) => {
      const values = group.map((sample) => sample[key]).filter((value) => value !== null)
      return [key, values.length ? Math.round(median(values) * 10) / 10 : null]
    })) }
  })
  const report = { node: process.version, platform: process.platform, measuredAt: new Date().toISOString(), samples, summary }
  const output = option('output', '')
  if (output) writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ summary }, null, 2))
}
