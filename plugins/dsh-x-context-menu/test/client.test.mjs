/**
 * 客户端包的结构断言：这个文件是给 ModuleLoader 的工厂产物，跑不进 node，
 * 所以只验契约与词典——文案键漏一个，界面上就会显示成键名。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8')

/** 从 `const zh = {` 开始按大括号配对取出对象字面量，再抽一级键名。 */
function dictionaryKeys(name) {
  const start = source.indexOf(`const ${name} = {`)
  assert.notEqual(start, -1, `找不到 ${name} 词典`)
  let index = source.indexOf('{', start)
  let depth = 0
  let end = -1
  for (; index < source.length; index += 1) {
    const character = source[index]
    if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth === 0) {
        end = index
        break
      }
    }
  }
  assert.notEqual(end, -1, `${name} 词典没有闭合`)
  const body = source.slice(start, end)
  return [...body.matchAll(/^\t\t\t([A-Za-z][A-Za-z0-9]*):/gm)].map((match) => match[1])
}

test('ModuleLoader 契约：id / inject / 导出', () => {
  assert.match(source, /window\.__ModuleLoader__\.load\(\{/)
  assert.match(source, /id: "dsh-x-context-menu"/)
  assert.match(source, /const inject = \["slots", "locale"\]/)
  assert.match(source, /return \{ apply, inject \};/)
})

test('词典：中英键集合一致，且没有重复', () => {
  const zh = dictionaryKeys('zh')
  const en = dictionaryKeys('en')
  assert.ok(zh.length > 20, `中文词典太小：${zh.length}`)
  assert.deepEqual([...zh].sort(), [...en].sort())
  assert.equal(new Set(zh).size, zh.length, '中文词典有重复键')
})

test('用到的每个 t("key") 都在词典里', () => {
  const keys = new Set(dictionaryKeys('zh'))
  const used = [...source.matchAll(/\bt\("([A-Za-z][A-Za-z0-9]*)"/g)].map((match) => match[1])
  assert.ok(used.length > 10)
  for (const key of new Set(used)) assert.ok(keys.has(key), `词典缺 ${key}`)
})

test('挂到 shell.overlay，并保留默认右键行为', () => {
  assert.match(source, /ctx\.slots\.inject\("shell\.overlay"/)
  assert.match(source, /ctx\.slots\.register\(/)
  assert.match(source, /if \(!menu\) return;/)
})

test('动作走官方服务与自家环回路由', () => {
  for (const call of [
    'archiveSession',
    'pinSession',
    'unpinSession',
    'forkSession',
    'startSession',
    'sessions.manager?.rename',
  ]) {
    assert.ok(source.includes(call), `缺少对 ${call} 的调用`)
  }
  assert.match(source, /\/api\/x-context-menu\/reveal/)
  assert.match(source, /\/api\/x-context-menu\/open-url/)
})

test('目标解析只认 data-row-key 的两种前缀', () => {
  assert.match(source, /key\.startsWith\("session:"\)/)
  assert.match(source, /key\.startsWith\("workspace:"\)/)
})
