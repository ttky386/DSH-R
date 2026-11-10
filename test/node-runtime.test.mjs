import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import test from 'node:test'
import { isolateUserHome } from './isolated-home.mjs'

const folder = mkdtempSync(join(tmpdir(), 'dsh-node-runtime-'))
isolateUserHome(folder)
const { findSystemNode, nodeRuntimeView, parseNodeRange } = await import('../src/server.js')
test.after(() => rmSync(folder, { recursive: true, force: true }))

test('findSystemNode：显式路径优先，其次按 PATH 找，找不到返回空串', () => {
  const bin = mkdtempSync(join(tmpdir(), 'dsh-node-bin-'))
  try {
    const explicit = join(bin, process.platform === 'win32' ? 'node.exe' : 'node')
    writeFileSync(explicit, '')
    const empty = join(bin, 'empty')
    const onlyExplicit = (file) => file === explicit
    // 显式路径：存在就用它（不要求文件名叫 node，nvm/volta 的包装都行）
    assert.equal(findSystemNode(explicit, { env: { PATH: '' }, platform: process.platform, exists: onlyExplicit }), explicit)
    // 只填命令名：按 PATH 找
    assert.equal(findSystemNode('node', { env: { PATH: bin }, platform: process.platform, exists: onlyExplicit }), explicit)
    // 没填：按 PATH 找 node / node.exe
    assert.equal(findSystemNode('', { env: { PATH: `${empty}${delimiter}${bin}` }, platform: process.platform, exists: onlyExplicit }), explicit)
    // 找不到就是空串，页面据此说明「系统里没找到 Node」
    assert.equal(findSystemNode('', { env: { PATH: empty }, platform: process.platform, exists: () => false }), '')
    // 显式路径不存在时不回落到 PATH 里的另一个 node（用户指哪就是哪，别悄悄换一个）
    assert.equal(findSystemNode(join(empty, 'node'), { env: { PATH: bin }, platform: process.platform, exists: onlyExplicit }), '')
    // Windows 的 PATH 条目可能带引号
    assert.equal(findSystemNode('', { env: { PATH: `"${bin}"` }, platform: 'win32', exists: (file) => file === join(bin, 'node.exe') }), join(bin, 'node.exe'))
  } finally {
    rmSync(bin, { recursive: true, force: true })
  }
})

test('parseNodeRange 只认 >=x.y.z，别的范围不拿它下结论', () => {
  assert.equal(parseNodeRange('>=24.9.0'), '24.9.0')
  assert.equal(parseNodeRange(' >= 22.18.0 '), '22.18.0')
  assert.equal(parseNodeRange('^24.0.0'), '')
  assert.equal(parseNodeRange('>=24'), '')
  assert.equal(parseNodeRange(undefined), '')
})

test('源码运行时 dsh 就是用启动它的 Node，设置项只读', () => {
  const view = nodeRuntimeView({ nodeRuntime: 'system', systemNodePath: '' })
  assert.equal(view.selectable, false)
  assert.equal(view.effective.kind, 'system')
  assert.equal(view.effective.path, process.execPath)
  assert.equal(view.pending, false)
})
