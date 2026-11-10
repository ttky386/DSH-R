import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { verificationSummary } from '../src/repair-actions.js'

const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8')
const body = server.slice(server.indexOf('  async verify(target) {'), server.indexOf('\n})', server.indexOf('  async verify(target) {')))
const target = { home: '/isolated', profile: 'desktop', version: '1.0.0' }
const clean = { failed: [], rejected: [], blockingChains: [], waiting: [], skipped: { entries: [] } }

function verification(start, current = []) {
  const old = { ...target, binding: { attemptId: 'old' }, diagnosis: clean }
  return vm.runInNewContext(`({${body}}).verify`, {
    startNow: start,
    instanceList: () => current,
    lastFailure: old,
    verificationSummary,
    REPAIR_OBSERVATION_MS: 0,
    setTimeout: callback => callback(),
  })
}

function processFixture() {
  return { ...target, diagnosticContext: { ...target, attemptId: 'new' }, diagnosis: { report: () => clean }, status: 'running', child: { exitCode: null } }
}

test('verification refuses stale failure and unrelated process when startup fails before spawn', async () => {
  const unrelated = processFixture()
  await assert.rejects(verification(async () => {
    throw new Error('missing entry')
  }, [unrelated])(target), /missing entry/)
})

test('verification retains current failed attempt and never reads an unrelated replacement', async () => {
  const started = processFixture()
  started.child.exitCode = 1
  started.diagnosis.report = () => ({ ...clean, failed: [{ id: 'new-fault' }] })
  const result = await verification(async (version, profile, onStarted) => {
    onStarted(started)
    const error = new Error('current failed')
    error.failure = { ...target, binding: { attemptId: 'new' }, diagnosis: started.diagnosis.report() }
    throw error
  }, [processFixture()])(target)
  assert.equal(result.ready, false)
  assert.equal(result.alive, false)
  assert.equal(result.remaining.failed, 1)
})

test('verification follows its own process through ready then exit', async () => {
  const started = processFixture()
  const result = await verification(async (version, profile, onStarted) => {
    onStarted(started)
    started.child.exitCode = 1
    started.diagnosis.report = () => ({ ...clean, failed: [{ id: 'after-ready' }] })
  })(target)
  assert.equal(result.ready, true)
  assert.equal(result.alive, false)
  assert.equal(result.status, 'unresolved')
  assert.equal(result.remaining.failed, 1)
})

test('verification rejects mismatched target identities and missing current reports', async () => {
  for (const field of ['home', 'profile', 'version', 'report']) {
    const started = processFixture()
    if (field === 'report') {
      started.diagnosis.report = () => null
    } else {
      started.diagnosticContext[field] = 'different'
    }
    await assert.rejects(verification(async (version, profile, onStarted) => {
      onStarted(started)
    }, [started])(target), /未取得本次启动/)
  }
})

test('verification resolves only its captured live process', async () => {
  const started = processFixture()
  const result = await verification(async (version, profile, onStarted) => {
    onStarted(started)
  }, [started])(target)
  assert.equal(result.status, 'resolved')
})

test('reused running or starting instance cannot stand in for a new verification attempt', async () => {
  const startBody = server.slice(server.indexOf('async function startNow('), server.indexOf('\n/** 一次启动尝试', server.indexOf('async function startNow(')))
  for (const status of ['running', 'starting']) {
    const existing = { ...processFixture(), status, url: 'http://localhost/' }
    const start = vm.runInNewContext(`(${startBody})`, {
      safeVersion: value => value,
      safeProfile: value => value,
      listProfiles: () => [target.profile],
      instances: new Map([['key', existing]]),
      instanceKey: () => 'key',
      waitUntilReady: async () => ({ url: existing.url }),
    })
    await assert.rejects(verification(start, [existing])(target), /未取得本次启动/)
  }
})
