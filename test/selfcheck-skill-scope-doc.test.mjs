import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('selfcheck instructions distinguish explicit target failures from default local fallback', () => {
  const text = readFileSync(new URL('../skills/dsh-x-selfcheck/SKILL.md', import.meta.url), 'utf8')
  const net = text.split('\n').find(line => line.startsWith('| `--net`'))
  assert.match(net, /未指定.*--port.*直连/)
  assert.match(net, /指定.*未连接.*不.*直连/)
  const boundary = text.slice(text.indexOf('## 边界'), text.indexOf('## 安装/升级'))
  assert.match(boundary, /未指定.*--port.*文件/)
  assert.match(boundary, /指定.*--port.*不.*当前终端/)
  assert.match(boundary, /未指定.*--port.*manager\.log/)
  assert.match(boundary, /原始设置文件.*未验证/)
})
