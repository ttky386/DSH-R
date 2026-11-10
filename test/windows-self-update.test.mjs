import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { copyFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { isolateUserHome } from './isolated-home.mjs'

const compiler = join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')

test('Windows 自更新：GUI 安装器真实执行后才交接，脱离父进程并正确处理启动失败', {
  skip: process.platform !== 'win32' || !existsSync(compiler), timeout: 20000,
}, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dsh updater O'Brien 中文 "))
  isolateUserHome(root)
  const bin = join(root, 'programs')
  mkdirSync(bin)
  const source = join(bin, 'probe.cs')
  const ready = join(bin, 'ready.exe')
  // 仅写临时日志的 GUI 程序，不包含安装操作；直接覆盖实际 Windows CreateProcess 及父进程退出。
  writeFileSync(source, `
using System;
using System.IO;
using System.Threading;
using System.Reflection;
class Probe {
  static void Main(string[] args) {
    string mode = Path.GetFileNameWithoutExtension(Assembly.GetExecutingAssembly().Location);
    if (mode == "failed") { Environment.Exit(7); return; }
    string log = Array.Find(args, value => value.StartsWith("/log=")).Substring(5);
    if (mode == "stalled") { Thread.Sleep(1000); return; }
    if (mode == "slow") { File.WriteAllText(log, ""); Thread.Sleep(400); }
    File.WriteAllText(log, string.Join("\\n", args));
    Thread.Sleep(800);
    File.WriteAllText(log + ".done", "finished");
  }
}
`)
  const built = spawnSync(compiler, ['/nologo', '/target:winexe', `/out:${ready}`, source], { encoding: 'utf8', windowsHide: true })
  assert.equal(built.status, 0, built.stdout + built.stderr)
  const { launchWindowsInstaller } = await import('../src/server.js')
  // detached 的探针最长运行 1.2 秒；等其结束再清理，Windows 才能释放 exe。
  t.after(async () => { await new Promise(resolve => setTimeout(resolve, 1500)); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) })

  const log = join(root, 'installation log.txt')
  const parentScript = `import {launchWindowsInstaller} from ${JSON.stringify(new URL('../src/server.js', import.meta.url).href)};
    const info=await launchWindowsInstaller(${JSON.stringify(ready)},${JSON.stringify(log)});
    console.log(JSON.stringify(info));process.exit(0);`
  const parent = spawn(process.execPath, ['--input-type=module', '-e', parentScript], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let output = '', errors = ''
  parent.stdout.on('data', data => { output += data })
  parent.stderr.on('data', data => { errors += data })
  assert.equal((await once(parent, 'exit'))[0], 0, errors)
  assert.ok(JSON.parse(output).pid > 0)
  const started = await readFile(log, 'utf8')
  assert.equal(started.replace(/^\uFEFF/, ''), `/silent\n/log=${log}`, '中文、单引号、空格原样传给安装器')
  const deadline = Date.now() + 5000
  while (!existsSync(log + '.done') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(await readFile(log + '.done', 'utf8'), 'finished', '启动器退出后 GUI 安装器继续执行')

  const slow = join(bin, 'slow.exe')
  await copyFile(ready, slow)
  const before = Date.now()
  await launchWindowsInstaller(slow, join(root, 'slow.log'))
  assert.ok(Date.now() - before >= 350, '空日志和进程已存在不能作为已开始安装的证据')

  const stalled = join(bin, 'stalled.exe')
  await copyFile(ready, stalled)
  const staleLog = join(root, 'stale.log')
  writeFileSync(staleLog, 'previous installation')
  await assert.rejects(launchWindowsInstaller(stalled, staleLog, { timeoutMs: 200 }), /尚未开始安装.*保持运行/)
  assert.equal(existsSync(staleLog), false, '上次的日志不能让未执行的安装器被误判为就绪')

  const failed = join(bin, 'failed.exe')
  await copyFile(ready, failed)
  await assert.rejects(launchWindowsInstaller(failed, join(root, 'failed.log')), /退出码 7/)
  await assert.rejects(launchWindowsInstaller(join(bin, 'missing.exe'), join(root, 'missing.log')), /无法启动.*ENOENT/)
})
