import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { createStartupResolver, installationRoots, patchProfileBoot } from '../src/perf/startup-resolver.mjs'

const root = 'file:///installed/node_modules/'
const context = (file = 'left.mjs', conditions = ['node', 'import']) => ({ parentURL: root + 'pkg/' + file, conditions })

test('同目录相对依赖复用解析，保留模块身份，结束启动后不再缓存', () => {
  const resolver = createStartupResolver({ roots: [root] })
  let calls = 0
  const next = () => { calls++; return { url: root + 'pkg/shared.mjs', format: 'module' } }
  resolver.begin()
  const first = resolver.resolve('./shared.mjs', context(), next)
  const second = resolver.resolve('./shared.mjs', context('right.mjs'), next)
  assert.equal(second.url, first.url)
  assert.equal(second.shortCircuit, true)
  assert.equal(calls, 1)
  resolver.end()
  assert.equal(resolver.stats().size, 0)
  resolver.resolve('./shared.mjs', context('later.mjs'), next)
  assert.equal(calls, 2)
})

test('不跨版本目录或条件，裸包名、Profile 文件、带属性/查询的导入走原解析器', () => {
  const resolver = createStartupResolver({ roots: [root] })
  resolver.begin()
  let calls = 0
  const next = () => { calls++; return { url: root + 'shared.mjs', format: 'module' } }
  resolver.resolve('./shared.mjs', context(), next)
  resolver.resolve('./shared.mjs', context('b.mjs', ['custom']), next)
  resolver.resolve('./shared.mjs', context('c.mjs', new Set(['node', 'require'])), next)
  const inputs = [
    ['some-package', context()],
    ['./shared.mjs', { ...context(), parentURL: 'file:///another-version/node_modules/pkg/a.mjs' }],
    ['./shared.mjs', { ...context(), parentURL: 'file:///home/profiles/web/node_modules/pkg/a.mjs' }],
    ['./shared.mjs', context('a.mjs?fresh=1')],
    ['./shared.mjs', { ...context(), importAttributes: { type: 'json' } }],
  ]
  for (const [specifier, ctx] of inputs) {
    resolver.resolve(specifier, ctx, next)
    resolver.resolve(specifier, ctx, next)
  }
  assert.equal(calls, 13)
  resolver.end()
})

test('失败不缓存，容量有界，嵌套启动和禁用开关不留下旧结果', () => {
  const resolver = createStartupResolver({ roots: [root], limit: 1 })
  resolver.begin(); resolver.begin()
  let calls = 0
  const failed = () => { calls++; throw new Error('missing') }
  for (let i = 0; i < 2; i++) assert.throws(() => resolver.resolve('./missing.mjs', context(), failed), /missing/)
  assert.equal(calls, 2)
  const next = () => ({ url: root + 'target.mjs' })
  resolver.resolve('./first.mjs', context(), next)
  resolver.resolve('./second.mjs', context(), next)
  assert.equal(resolver.stats().size, 1)
  resolver.end()
  assert.equal(resolver.stats().active, true)
  resolver.end()
  assert.equal(resolver.stats().size, 0)
  const disabled = createStartupResolver({ roots: [root], enabled: false })
  disabled.begin()
  disabled.resolve('./first.mjs', context(), next)
  assert.equal(disabled.stats().size, 0)
  assert.equal(patchProfileBoot('async function unknown(options) {}'), 'async function unknown(options) {}')
})

test('真实 ESM 启动保留同一依赖实例，启动后删除文件会正常报错，失败也清空缓存', (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'dsh startup resolve-'))
  t.after(() => rmSync(folder, { recursive: true, force: true }))
  const lib = join(folder, 'node_modules', '@deepseek-ai', 'dsh', 'lib')
  const parts = join(lib, 'parts')
  mkdirSync(parts, { recursive: true })
  writeFileSync(join(parts, 'shared.mjs'), 'export const value = {}')
  writeFileSync(join(parts, 'shared.cjs'), 'module.exports = {}')
  for (const name of ['cjs-left', 'cjs-right']) writeFileSync(join(parts, name + '.cjs'), "module.exports = require('./shared.cjs')")
  for (const name of ['left', 'right', 'later']) writeFileSync(join(parts, name + '.mjs'), "export { value } from './shared.mjs'")
  const source = `async function runProfile(options) {
    if (options.fail) throw new Error('boot failed')
    const { createRequire } = await import('node:module')
    const require = createRequire(import.meta.url)
    if (require('./parts/cjs-left.cjs') !== require('./parts/cjs-right.cjs')) throw new Error('CJS identity changed')
    const [left, right] = await Promise.all([import('./parts/left.mjs'), import('./parts/right.mjs')])
    return left.value === right.value
  }
  export { runProfile }`
  writeFileSync(join(lib, 'profile-boot-test.js'), source)
  writeFileSync(join(folder, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), '{"type":"module"}')
  writeFileSync(join(lib, 'bin.js'), '')
  const runner = join(folder, 'run.mjs')
  writeFileSync(runner, `
    import assert from 'node:assert/strict'
    import { rmSync } from 'node:fs'
    import { runProfile } from './node_modules/@deepseek-ai/dsh/lib/profile-boot-test.js'
    assert.equal(await runProfile({}), true)
    const cache = globalThis[Symbol.for('dsh-x/startup-resolver')]
    assert.ok(cache.stats().hits > 0)
    assert.equal(cache.stats().active, false)
    rmSync(new URL('./node_modules/@deepseek-ai/dsh/lib/parts/shared.mjs', import.meta.url))
    await assert.rejects(import('./node_modules/@deepseek-ai/dsh/lib/parts/later.mjs'), { code: 'ERR_MODULE_NOT_FOUND' })
    await assert.rejects(runProfile({ fail: true }), /boot failed/)
    assert.equal(cache.stats().size, 0)
    assert.equal(cache.stats().active, false)
  `)
  const hook = new URL('../src/perf/register.mjs', import.meta.url).href
  const result = spawnSync(process.execPath, ['--import', hook, runner], { env: { ...process.env, DSH_BIN: join(lib, 'bin.js'), DSH_PERF_RESOLVE_CACHE: '1' }, encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, result.stderr)
  assert.ok(installationRoots(join(lib, 'bin.js')).some(url => pathToFileURL(join(parts, 'left.mjs')).href.startsWith(url)))
  assert.equal(readFileSync(join(lib, 'profile-boot-test.js'), 'utf8'), source, '安装文件不被改写')
})
