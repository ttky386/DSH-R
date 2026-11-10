import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

test('selfcheck subprocess regressions never discover a host manager or use a fixed port', () => {
  const source = readFileSync(new URL('./selfcheck-skill.test.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /run\(\['--(?:json|no-logs)'/)
  assert.doesNotMatch(source, /'--port', '9'/)
  assert.match(source, /server\.listen\(0, '127\.0\.0\.1'/)
})

test('default discovery preserves env, stored and default candidate order without network access', () => {
  const source = readFileSync(new URL('../skills/dsh-x-selfcheck/scripts/selfcheck.mjs', import.meta.url), 'utf8')
  const start = source.indexOf('  const envPort = Number(')
  const end = source.indexOf('  const discovery =', start)
  for (const [envPort, storedPort, expected] of [
    ['41001', 41002, [41001, 41002, 3780]],
    ['41001', 41001, [41001, 3780]],
    ['', 0, [3780]],
    ['invalid', -1, [3780]],
  ]) {
    const context = { process: { env: { PORT: envPort } }, ctx: { settings: { port: storedPort } }, opts: { port: 0 }, DEFAULT_PORT: 3780 }
    vm.runInNewContext(source.slice(start, end), context)
    assert.deepEqual(Array.from(context.ctx.portCandidates), expected)
  }
})
