import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { cmpVer, parseVer } from '../src/registry.js'

/** 只留符号，方便和 semver 的预期结果对照。 */
const sign = (value) => (value > 0 ? 1 : value < 0 ? -1 : 0)
const compare = (a, b) => sign(cmpVer(parseVer(a), parseVer(b)))

test('parseVer 解析正式版与预发布版', () => {
  assert.deepEqual(
    { ...parseVer('0.1.6-alpha.2'), raw: undefined },
    { major: 0, minor: 1, patch: 6, pre: 'alpha.2', parts: 3, raw: undefined },
  )
  assert.equal(parseVer('1.2').patch, 0)
  assert.equal(parseVer('1.2').parts, 2)
  assert.equal(parseVer('1.2.3+build.5').pre, '')
  assert.equal(parseVer('不是版本号'), null)
})

test('正式版高于同号预发布版', () => {
  assert.equal(compare('0.1.6', '0.1.6-alpha.2'), 1)
  assert.equal(compare('0.1.6-alpha.2', '0.1.6'), -1)
})

test('数字段按数值比，而不是按字符串比', () => {
  // 这两个是旧实现认错的地方：字符串比会得出 alpha.10 < alpha.2
  assert.equal(compare('0.1.6-alpha.10', '0.1.6-alpha.2'), 1)
  assert.equal(compare('0.1.5-rc.10', '0.1.5-rc.9'), 1)
  assert.equal(compare('1.0.0-alpha.2', '1.0.0-alpha.10'), -1)
  assert.equal(compare('1.0.0-rc.100', '1.0.0-rc.99'), 1)
})

test('数字段小于字母数字段，字母段按字典序', () => {
  assert.equal(compare('1.0.0-1', '1.0.0-alpha'), -1)
  assert.equal(compare('1.0.0-alpha', '1.0.0-beta'), -1)
  assert.equal(compare('0.1.5-alpha.2', '0.1.5-rc.1'), -1)
  assert.equal(compare('1.0.0-alpha.1', '1.0.0-1.1'), 1)
})

test('前缀相同时段数多的更大', () => {
  assert.equal(compare('1.0.0-alpha', '1.0.0-alpha.1'), -1)
  assert.equal(compare('1.0.0-alpha.1', '1.0.0-alpha'), 1)
})

test('主次修订号优先于预发布段', () => {
  assert.equal(compare('0.1.6-alpha.1', '0.1.5'), 1)
  assert.equal(compare('0.2.0-alpha.1', '0.1.9'), 1)
  assert.equal(compare('1.0.0', '0.9.9'), 1)
})

test('相同版本相等', () => {
  assert.equal(compare('0.1.6-alpha.2', '0.1.6-alpha.2'), 0)
  assert.equal(compare('0.1.6', '0.1.6'), 0)
})

test('版本列表按从新到旧排序（目录里给定顺序会被排好）', () => {
  const list = ['0.1.6-alpha.2', '0.1.5-rc.10', '0.1.6-alpha.10', '0.1.5', '0.1.6']
  const sorted = [...list].sort((a, b) => cmpVer(parseVer(b), parseVer(a)))
  assert.deepEqual(sorted, ['0.1.6', '0.1.6-alpha.10', '0.1.6-alpha.2', '0.1.5', '0.1.5-rc.10'])
})

/**
 * 管理页里有一份等价的 compareVersion（页面没有打包器，没法直接 import）。
 * 这里用花括号配对从 index.html 抠出整个函数体跑一遍，两边结果必须一致，
 * 免得只改了 registry.js、页面上还是旧口径。
 */
function pageCompareVersion() {
  const html = readFileSync(new URL('../src/public/index.html', import.meta.url), 'utf8')
  const start = html.indexOf('function compareVersion(a, b) {')
  assert.notEqual(start, -1, 'index.html 里找不到 compareVersion')
  let depth = 0
  for (let i = html.indexOf('{', start); i < html.length; i += 1) {
    if (html[i] === '{') depth += 1
    else if (html[i] === '}') {
      depth -= 1
      if (depth === 0) {
        const source = html.slice(start, i + 1)
        // eslint-disable-next-line no-new-func
        return new Function(`${source}; return compareVersion`)()
      }
    }
  }
  throw new Error('compareVersion 函数体不完整')
}

test('管理页的 compareVersion 与 registry.js 的 cmpVer 结论一致', () => {
  const pageCompare = pageCompareVersion()
  const samples = [
    '0.1.6-alpha.2', '0.1.6-alpha.10', '0.1.6', '0.1.5-rc.9', '0.1.5-rc.10',
    '0.1.5', '0.1.0-rc.8', '1.0.0-1', '1.0.0-alpha', '1.0.0-alpha.1', '0.0.1-rc.5',
    '1.2.3+build.5', '1.2.3-alpha.1+build.5',
  ]
  for (const a of samples) {
    for (const b of samples) {
      assert.equal(
        sign(pageCompare(a, b)),
        sign(cmpVer(parseVer(a), parseVer(b))),
        `compareVersion(${a}, ${b}) 与 cmpVer 不一致`,
      )
    }
  }
})
