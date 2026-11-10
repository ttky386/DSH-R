import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { incompatibleDirectDeps } from '../src/server.js'

/** 造一个假 profile：直接依赖 + 各自的 package.json。 */
function profile(deps) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-incompatible-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: Object.fromEntries(Object.keys(deps).map((name) => [name, '1.0.0'])) }))
  for (const [name, requirements] of Object.entries(deps)) {
    const pkgDir = join(dir, 'node_modules', name)
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name, version: '1.0.0', dependencies: requirements.dependencies, peerDependencies: requirements.peerDependencies }))
  }
  return dir
}

test('不兼容直接依赖：精确钉死的 @deepseek-ai 版本不等于运行时才算；范围写法不算', () => {
  const dir = profile({
    '@deepseek-ai/dsh-subagent-codex': { dependencies: { '@deepseek-ai/dsh-tool-subagent': '0.2.1-alpha.2', '@deepseek-ai/dsh-brand': '0.2.1-rc.3' } },
    'some-third-party': { dependencies: { '@deepseek-ai/dsh-llm': '0.2.1-alpha.2' } },
    'compatible-plugin': { dependencies: { '@deepseek-ai/dsh-llm': '0.2.1-rc.3' } },
    'range-plugin': { dependencies: { '@deepseek-ai/dsh-llm': '^0.2.1-rc.3' } },
  })
  try {
    const found = incompatibleDirectDeps(dir, '0.2.1-rc.3')
    assert.deepEqual(found.map((item) => item.name).sort(), ['@deepseek-ai/dsh-subagent-codex', 'some-third-party'])
    assert.deepEqual(found.find((item) => item.name === '@deepseek-ai/dsh-subagent-codex').requirements, ['@deepseek-ai/dsh-tool-subagent@0.2.1-alpha.2'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('不兼容直接依赖：peerDependencies 里的精确钉死同样算', () => {
  const dir = profile({
    'peer-pinned': { peerDependencies: { '@deepseek-ai/dsh-session': '0.2.1-alpha.2' } },
  })
  try {
    assert.deepEqual(incompatibleDirectDeps(dir, '0.2.1-rc.3').map((item) => item.name), ['peer-pinned'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
