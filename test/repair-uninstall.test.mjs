import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DiagnosticRepairs } from '../src/repair-actions.js'

function fixture() {
  const home = mkdtempSync(join(realpathSync.native(tmpdir()), 'diagnostic-uninstall-'))
  const profile = join(home, 'profiles/desktop')
  const source = join(profile, 'node_modules/renamed-introducer')
  mkdirSync(source, { recursive: true })
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'renamed-introducer', version: '1.0.0' }))
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ dependencies: { 'renamed-introducer': '1.0.0' } }))
  writeFileSync(join(profile, 'pnpm-lock.yaml'), '{}')
  writeFileSync(join(profile, 'node_modules/.modules.yaml'), '{}')
  writeFileSync(join(profile, 'cordis.patch.yml'), '- id: waiting\n  disabled: false\n')
  const target = { home, profile: 'desktop', version: '1', harnessEntry: join(home, 'bin.js') }
  const id = 'd'.repeat(32)
  const backupRoot = join(profile, '.dsh-x-repairs', id)
  const owner = { name: 'renamed-introducer', dir: source }
  const action = { id: 'remove-owner', kind: 'uninstall-introducer', component: 'old-provider', owner, backup: join(backupRoot, 'installation') }
  const inspected = { fingerprint: 'same', adaptation: null, evidence: { anchor: target.harnessEntry }, introducers: [{ component: action.component, owner, disabledReason: '' }] }
  let verified = 0
  let removed = 0
  const repairs = new DiagnosticRepairs({
    dataDir: () => join(home, 'data'),
    assertAvailable() {
    },
    async exclusive(target, operation) {
      return operation()
    },
    async stop() {
    },
    async installationExclusive(target, operation) {
      return operation()
    },
    async uninstall() {
      removed += 1
      rmSync(source, { recursive: true })
      throw new Error('package manager failed after partial changes')
    },
    async verify() {
      verified += 1
      return { status: 'unresolved', remaining: { failed: 1, rejected: 0, required: 0, waiting: 1, skipped: 0 } }
    },
  })
  repairs.current = () => ({})
  repairs.inspect = async () => inspected
  repairs.probe = async () => ({ rows: [{ name: 'old-provider', selected: { dir: '/runtime/provider', version: '2.0.0' }, incompatible: false }] })
  repairs.previews.set(id, { target, binding: {}, actions: [action], fingerprint: 'same', inspected, backupRoot, diagnosis: { failed: [{}], rejected: [], blockingChains: [], waiting: [{}], skipped: { entries: [] } } })
  return { repairs, id, action, inspected, profile, counts: () => ({ verified, removed }) }
}

test('partial uninstall failure records actual removal and still verifies without disabling waiting plugins', async () => {
  const item = fixture()
  const before = readFileSync(join(item.profile, 'cordis.patch.yml'), 'utf8')
  const record = await item.repairs.execute(item.id, item.action.id)
  assert.equal(record.status, 'uninstall_failed')
  assert.match(record.error, /partial/)
  assert.deepEqual(item.counts(), { removed: 1, verified: 1 })
  assert.ok(record.actualChanges.some(change => change.operation === 'package_inventory_changed' && change.after.present === false))
  assert.equal(readFileSync(join(item.profile, 'cordis.patch.yml'), 'utf8'), before)
  assert.equal(JSON.parse(readFileSync(join(item.profile, 'package.json'), 'utf8')).dependencies['renamed-introducer'], '1.0.0')
  await assert.rejects(item.repairs.rollback(record.id), /不支持一键回退/)
})

test('changed dependency fingerprint stops an old confirmation before uninstall', async () => {
  const item = fixture()
  item.repairs.inspect = async () => ({ ...item.inspected, fingerprint: 'changed-dependency' })
  await assert.rejects(item.repairs.execute(item.id, item.action.id), /已变化/)
  assert.deepEqual(item.counts(), { removed: 0, verified: 0 })
})

test('dependency changes after stopping also prevent uninstall', async () => {
  const item = fixture()
  let inspections = 0
  item.repairs.inspect = async () => {
    inspections += 1
    return { ...item.inspected, fingerprint: inspections === 1 ? 'same' : 'changed-after-stop' }
  }
  await assert.rejects(item.repairs.execute(item.id, item.action.id), /停止后/)
  assert.deepEqual(item.counts(), { removed: 0, verified: 0 })
})

test('the official installation lock is acquired before the final fingerprint check', async () => {
  const item = fixture()
  item.repairs.options.installationExclusive = async (target, operation) => {
    item.repairs.inspect = async () => ({ ...item.inspected, fingerprint: 'changed-while-waiting-for-official-lock' })
    return operation()
  }
  await assert.rejects(item.repairs.execute(item.id, item.action.id), /停止后/)
  assert.deepEqual(item.counts(), { removed: 0, verified: 0 })
})

test('uninstall and verification failures remain separate in persisted history', async () => {
  const item = fixture()
  item.repairs.options.verify = async () => {
    throw new Error('fresh verification failed before spawn')
  }
  await assert.rejects(item.repairs.execute(item.id, item.action.id), /fresh verification/)
  const record = item.repairs.readRecord(item.id)
  assert.equal(record.status, 'uninstall_failed')
  assert.match(record.error, /package manager failed after partial changes/)
  assert.equal(record.verificationStatus, 'failed')
  assert.match(record.verificationError, /fresh verification/)
  assert.equal(record.outcome, null)
  assert.ok(record.actualChanges.some(change => change.operation === 'package_inventory_changed'))
  const restarted = new DiagnosticRepairs(item.repairs.options)
  assert.deepEqual(restarted.readRecord(item.id), record)
})

test('successful uninstall stays successful when only verification fails', async () => {
  const item = fixture()
  item.repairs.options.uninstall = async () => {
  }
  item.repairs.options.verify = async () => {
    const pending = item.repairs.readRecord(item.id)
    assert.equal(pending.status, 'applied')
    assert.equal(pending.verificationStatus, 'pending')
    assert.equal(pending.outcome, null)
    throw new Error('verification report missing')
  }
  await assert.rejects(item.repairs.execute(item.id, item.action.id), error => {
    assert.match(error.message, /verification report missing/)
    assert.equal(error.repairRecord.id, item.id)
    assert.equal(error.repairRecord.status, 'applied_verification_failed')
    assert.equal(error.repairRecord.verificationStatus, 'failed')
    assert.deepEqual(error.repairRecord, item.repairs.readRecord(item.id))
    return true
  })
  const record = item.repairs.readRecord(item.id)
  assert.equal(record.status, 'applied_verification_failed')
  assert.equal(record.error, undefined)
  assert.equal(record.verificationStatus, 'failed')
  assert.match(record.verificationError, /verification report missing/)
})

test('completed verification is persisted independently of a failed uninstall', async () => {
  const item = fixture()
  const record = await item.repairs.execute(item.id, item.action.id)
  assert.equal(record.status, 'uninstall_failed')
  assert.equal(record.verificationStatus, 'complete')
  assert.equal(record.verificationError, undefined)
  assert.equal(record.outcome.status, 'unresolved')
})
