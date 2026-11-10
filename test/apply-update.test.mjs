import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const POSIX = process.platform !== 'win32'
const HELPER = new URL('../src/apply-update.mjs', import.meta.url)

/**
 * 替换助手的行为测试：用一个假启动器代替 DSH.exe。
 * 它要把「新版本起来了」的标记写出来，顺便把继承到的环境变量记下来——
 * 助手自己是 ELECTRON_RUN_AS_NODE 跑起来的，这个变量绝不能传给启动器。
 */
test('替换助手：换目录、重启、等标记、成功后清备份，且不把 ELECTRON_RUN_AS_NODE 传给启动器', { skip: !POSIX && '假启动器是 sh 脚本' }, () => {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), 'dsh-apply-'))
  const appDir = join(root, 'app')
  const staged = join(root, 'staged')
  const backup = join(root, 'app.bak')
  const marker = join(root, 'update-ok')
  const logFile = join(root, 'update.log')
  const envFile = join(root, 'launcher-env.txt')
  const exe = join(root, 'fake-launcher.sh')
  try {
    mkdirSync(appDir, { recursive: true })
    mkdirSync(staged, { recursive: true })
    writeFileSync(join(appDir, 'old.txt'), 'old\n')
    writeFileSync(join(staged, 'new.txt'), 'new\n')
    writeFileSync(exe, `#!/bin/sh\necho "runas=\${ELECTRON_RUN_AS_NODE:-}" > "${envFile}"\ntouch "${marker}"\n`)
    chmodSync(exe, 0o755)
    const result = spawnSync(process.execPath, [HELPER.pathname,
      '--app', appDir,
      '--staged', staged,
      '--exe', exe,
      '--pid', '999999',
      '--backup', backup,
      '--marker', marker,
      '--log', logFile,
    ], { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 30_000 })
    assert.equal(result.status, 0, `${result.stderr}\n${existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''}`)
    assert.equal(readFileSync(join(appDir, 'new.txt'), 'utf8'), 'new\n')
    assert.ok(!existsSync(join(appDir, 'old.txt')))
    assert.ok(!existsSync(backup), '启动成功后应清掉旧版本备份')
    assert.match(readFileSync(logFile, 'utf8'), /新版本启动成功/)
    assert.equal(readFileSync(envFile, 'utf8').trim(), 'runas=', 'ELECTRON_RUN_AS_NODE 不能传给启动器')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
