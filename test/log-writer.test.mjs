import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createLogWriter } from '../src/log-writer.js'

test('批量日志按原顺序保留中文，导出前 flush 包含最后一行', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-log-writer-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const file = join(root, 'nested', 'manager.log')
  const writer = createLogWriter(file)
  writer.append('中文🙂\n')
  writer.append('final error\n')
  assert.equal(existsSync(file), false, '小批次不逐行打开磁盘文件')
  writer.flush()
  assert.equal(readFileSync(file, 'utf8'), '中文🙂\nfinal error\n')
  writer.flush()
  assert.equal(readFileSync(file, 'utf8'), '中文🙂\nfinal error\n')
})

test('日志突发达到缓冲上限就落盘，后续小批次由计时器补齐', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-log-burst-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const file = join(root, 'manager.log')
  const writer = createLogWriter(file, { batchBytes: 16, delay: 10 })
  writer.append('0123456789abcdef')
  assert.equal(readFileSync(file, 'utf8'), '0123456789abcdef')
  writer.append('末行\n')
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(readFileSync(file, 'utf8'), '0123456789abcdef末行\n')
})

test('日志轮转保留前一份完整内容，写入失败不阻塞并可在下一批恢复', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-log-rotation-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const file = join(root, 'manager.log')
  const writer = createLogWriter(file, { maxBytes: 4 })
  writer.append('12345')
  writer.flush()
  writer.append('next')
  writer.flush()
  assert.equal(readFileSync(file + '.1', 'utf8'), '12345')
  assert.equal(readFileSync(file, 'utf8'), 'next')
  const blocked = join(root, 'blocked')
  writeFileSync(blocked, 'file, not directory')
  const retry = createLogWriter(join(blocked, 'manager.log'))
  retry.append('unwritable')
  assert.doesNotThrow(() => retry.flush())
  rmSync(blocked)
  mkdirSync(blocked)
  retry.append('recovered')
  retry.flush()
  assert.equal(readFileSync(join(blocked, 'manager.log'), 'utf8'), 'recovered')
})
