import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { mask } from '../skills/dsh-x-selfcheck/scripts/selfcheck.mjs'

const source = readFileSync(new URL('../skills/dsh-x-selfcheck/scripts/selfcheck.mjs', import.meta.url), 'utf8')
const html = readFileSync(new URL('../src/public/index.html', import.meta.url), 'utf8')

test('quoted JSON credentials including escaped strings and keys are fully masked', () => {
  const samples = [
    '{"token":"fixture-secret with spaces","message":"keep"}',
    '{"nested":{"secretAccessKey":"fixture-secret\\\"tail"},"message":"keep"}',
    '{"to\\u006ben":"fixture-secret\\\\tail","message":"keep"}',
    '{"Authorization":"Bearer fixture-secret","message":"keep"}',
    '{"cookie":"session=fixture-secret; other=value","message":"keep"}',
    '{"password":"fixture-secret\\nmore","message":"keep"}',
  ]
  for (const sample of samples) {
    const masked = mask(sample)
    assert.doesNotMatch(masked, /fixture-secret|tail|more/)
    assert.equal(JSON.parse(masked).message, 'keep')
  }
  assert.equal(mask('{"message":"ordinary diagnostic"}'), '{"message":"ordinary diagnostic"}')
  assert.doesNotMatch(mask('token=fixture-secret'), /fixture-secret/)
  assert.doesNotMatch(mask('Authorization: Basic Zml4dHVyZS1zZWNyZXQ='), /Zml4dHVyZS1zZWNyZXQ=/)
  const start = source.indexOf('function createReport()')
  const factory = source.slice(start, source.indexOf('\n}', start) + 2)
  const report = vm.runInNewContext(`${factory}\ncreateReport()`, { mask, SECTION_LABEL: {} })
  const secret = '{"token":"fixture-secret"}'
  report.add('log', 'fixture', 'warn', secret, secret, secret, [secret])
  assert.doesNotMatch(JSON.stringify(report.checks), /fixture-secret/)
})

test('entry shape inspection never claims malformed YAML is valid', () => {
  const start = source.indexOf('function looksLikeEntryList(')
  const shape = source.slice(start, source.indexOf('\n}', start) + 2)
  const branchStart = source.indexOf('  const patchPath = join(profileDir,')
  const branch = source.slice(branchStart, source.indexOf('  const lockPath =', branchStart))
  const checks = []
  vm.runInNewContext(`${shape}\n${branch}`, {
    profileDir: '/isolated/profile',
    join,
    isFile: () => {
      return true
    },
    readText: () => {
      return '- id: fixture\n  config: [\n'
    },
    readPatchDisables: () => {
      return []
    },
    report: {
      add: (...args) => {
        checks.push(args)
      },
    },
  })
  assert.equal(checks.length, 1)
  assert.doesNotMatch(checks[0][3], /合法/)
  assert.match(checks[0].join(' '), /语法.*未验证/)
})

test('copied selfcheck command binds the requesting manager port', async () => {
  const start = html.indexOf('copySelfcheckEl.onclick = async () => {')
  const handler = html.slice(start, html.indexOf('    webBindEl.onchange', start))
  for (const port of ['55226', '55227']) {
    let copied = ''
    const context = {
      copySelfcheckEl: {},
      getJson: async () => {
        return { skills: [] }
      },
      t: (text) => {
        return text
      },
      location: { port, protocol: 'http:' },
      copyPlainText: async (text) => {
        copied = text
      },
      notify: () => {
      },
    }
    vm.runInNewContext(handler, context)
    await context.copySelfcheckEl.onclick()
    assert.match(copied, new RegExp(`--port ${port}\\b`))
    assert.equal(context.copySelfcheckEl.disabled, false)
  }
})

test('incompatible plugin advice does not recommend downgrading Harness', () => {
  assert.equal(source.includes('换回兼容的 dsh 版本'), false)
})
