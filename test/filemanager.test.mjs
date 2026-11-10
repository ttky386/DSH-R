import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FileManager, PosixFileManager } from '../src/filemanager-base.js'
import { MacFileManager } from '../src/filemanager-mac.js'
import { WindowsFileManager } from '../src/filemanager-windows.js'
import { LinuxFileManager } from '../src/filemanager-linux.js'
import { copyAppFiles } from '../scripts/pack-common.mjs'

/**
 * 文件管理接口的契约用例：三套实现跑同一组断言。
 */
const IMPLEMENTATIONS = [['windows', WindowsFileManager], ['mac', MacFileManager], ['linux', LinuxFileManager]]

/** 这些成员没有通用答案，每个平台都得自己给，不能从基类继承一个「不支持」糊过去。 */
const MUST_IMPLEMENT = [
  'platform', 'userAppDir', 'launcherExecutable', 'directoryOpener',
  'pickDirectory', 'pickFile', 'revealPath', 'openUrl',
  'autoStartEnabled', 'setAutoStart',
]

function spy(Implementation, { stdout = '', error = null, deps = {} } = {}) {
  const calls = []
  const fm = new Implementation({
    existsSync: () => true,
    execFile(command, args, options, callback) {
      calls.push({ command, args: Array.from(args), options })
      const done = typeof options === 'function' ? options : callback
      done(error, stdout, error?.stderr || '')
    },
    ...deps,
  })
  return { fm, calls }
}

test('每套实现都继承契约，并且自己实现了没有通用答案的那些成员', () => {
  for (const [name, Implementation] of IMPLEMENTATIONS) {
    const fm = new Implementation()
    assert.ok(fm instanceof FileManager, `${name} 要从 FileManager 继承`)
    assert.equal(fm.platform, name)
    for (const member of MUST_IMPLEMENT) {
      assert.ok(Object.hasOwn(Implementation.prototype, member), `${name} 没自己实现 ${member}`)
    }
  }
})

test('路径语义：Windows 不分大小写、用 junction、按 PATHEXT 找命令；macOS/Linux 都反过来', () => {
  const windows = new WindowsFileManager({ env: { PATHEXT: '.EXE;.CMD' }, existsSync: (path) => path.endsWith('pnpm.CMD') })
  assert.ok(windows.samePath('C:\\Users\\A\\DSH', 'c:\\users\\a\\dsh'))
  assert.equal(windows.pathKey('C:\\A'), 'c:\\a')
  assert.equal(windows.directoryLinkType, 'junction')
  assert.ok(windows.hasCommand('C:\\bin', 'pnpm'), '按 PATHEXT 补出 pnpm.CMD')

  // join 在 Windows 上给反斜杠，假 existsSync 不能按 '/' 结尾匹配
  const mac = new MacFileManager({ existsSync: (path) => /[\\/]pnpm$/.test(path) })
  assert.ok(!mac.samePath('/Users/A/dsh', '/users/a/dsh'), 'mac 上不同大小写就是两个路径')
  assert.equal(mac.directoryLinkType, 'dir')
  assert.deepEqual(mac.commandExtensions, [''])
  assert.ok(mac.hasCommand('/usr/local/bin', 'pnpm'))
  assert.ok(!mac.samePath('', ''), '空路径不算同一个')

  const linux = new LinuxFileManager({ env: {}, existsSync: (path) => /[\\/]pnpm$/.test(path) })
  assert.ok(!linux.samePath('/home/a/dsh', '/home/A/dsh'), 'Linux 上不同大小写就是两个路径')
  assert.equal(linux.directoryLinkType, 'dir')
  assert.deepEqual(linux.commandExtensions, [''])
  assert.ok(linux.hasCommand('/usr/local/bin', 'pnpm'))
})

test('目录选择：Windows 走 PowerShell，macOS 走 AppleScript，Linux 优先 Electron 原生对话框', async () => {
  const windows = spy(WindowsFileManager, { stdout: 'D:\\目标目录\r\n' })
  assert.equal(await windows.fm.pickDirectory('D:\\起点'), 'D:\\目标目录')
  const [call] = windows.calls
  assert.equal(call.command, 'powershell')
  assert.ok(call.args.includes('-EncodedCommand'), '命令行里不留原文，省得再去转义')
  const script = Buffer.from(call.args.at(-1), 'base64').toString('utf16le')
  assert.match(script, /FolderBrowserDialog/)
  assert.match(script, /FromBase64String/, '起始路径按 base64 传，中文和引号不会被拼坏')

  const mac = spy(MacFileManager, { stdout: '/Users/a/目标目录/\n' })
  assert.equal(await mac.fm.pickDirectory('/Users/a'), '/Users/a/目标目录', 'POSIX path 的尾斜杠要去掉')
  assert.equal(mac.calls[0].command, 'osascript')
  assert.match(mac.calls[0].args.join(' '), /choose folder/)

  const linuxDialog = { showOpenDialog: async () => ({ canceled: false, filePaths: ['/home/a/目标目录'] }) }
  const linux = new LinuxFileManager({ dialog: linuxDialog, existsSync: () => true })
  assert.equal(await linux.pickDirectory('/home/a'), '/home/a/目标目录')
})

test('用户点取消返回空串，不是报错', async () => {
  const canceled = Object.assign(new Error('User canceled'), { stderr: 'execution error: 用户取消了。 (-128)' })
  const mac = spy(MacFileManager, { error: canceled })
  assert.equal(await mac.fm.pickDirectory(), '')
  assert.equal(await spy(MacFileManager, { error: canceled }).fm.pickFile({ save: true, defaultName: 'a.zip' }), '')
  // 别的错误照抛，别让用户以为自己点了取消
  await assert.rejects(spy(MacFileManager, { error: Object.assign(new Error('osascript 挂了'), { stderr: '' }) }).fm.pickDirectory(), /osascript/)

  const linuxDialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }
  assert.equal(await new LinuxFileManager({ dialog: linuxDialog }).pickDirectory(), '')
})

test('打开地址：Windows 过滤 cmd 的元字符，macOS 原样交给 open，Linux 用 xdg-open', async () => {
  const windows = spy(WindowsFileManager)
  await windows.fm.openUrl('http://127.0.0.1:9716/?token=abc')
  assert.deepEqual(windows.calls[0].args, ['/c', 'start', '', 'http://127.0.0.1:9716/?token=abc'])
  // cmd 会把这行再解析一遍：带 & 的地址能拼出任意命令，直接拒掉
  await assert.rejects(spy(WindowsFileManager).fm.openUrl('http://127.0.0.1:1/?&calc'), /不能安全打开/)

  const mac = spy(MacFileManager)
  await mac.fm.openUrl('http://127.0.0.1:1/?&x=1')
  assert.deepEqual(mac.calls[0], { command: 'open', args: ['http://127.0.0.1:1/?&x=1'], options: {} })

  const linux = spy(LinuxFileManager)
  await linux.fm.openUrl('http://127.0.0.1:1/?&x=1')
  assert.deepEqual(linux.calls[0], { command: 'xdg-open', args: ['http://127.0.0.1:1/?&x=1'], options: { timeout: 15000 } })
})

test('Linux：XDG 目录、AppImage 自启、zenity/kdialog 对话框', async () => {
  const linux = new LinuxFileManager({ home: '/home/a', env: { XDG_CONFIG_HOME: '/home/a/.config' }, existsSync: () => true })
  assert.equal(linux.platform, 'linux')
  assert.equal(linux.userAppDir(), join('/home/a/.config', 'DSH'))
  assert.equal(linux.autoStartPath, join('/home/a/.config', 'autostart', 'io.github.yyh-001.dsh-x.desktop'))

  const appImage = new LinuxFileManager({ home: '/home/a', env: { APPIMAGE: '/home/a/DSH-X.AppImage' }, existsSync: () => true })
  assert.equal(appImage.launcherExecutable(), '/home/a/DSH-X.AppImage')
  assert.deepEqual(appImage.launchArgs(), ['/home/a/DSH-X.AppImage'])

  const writes = []
  const autostart = new LinuxFileManager({
    home: '/home/a', env: {}, existsSync: () => true,
    mkdir: async () => {}, rm: async () => {}, writeFile: async (path, body) => { writes.push([path, body]) },
  })
  await autostart.setAutoStart(true)
  assert.match(writes[0][1], /\[Desktop Entry\]/)
  assert.match(writes[0][1], /X-GNOME-Autostart-enabled=true/)

  const dialog = spy(LinuxFileManager, { stdout: '/home/a/项目\n' })
  assert.equal(await dialog.fm.pickDirectory('/home/a'), '/home/a/项目')
  assert.equal(dialog.calls[0].command, 'zenity')
  assert.ok(dialog.calls[0].args.includes('--directory'))
  assert.equal(await spy(LinuxFileManager, { stdout: '/home/a/a.zip\n' }).fm.pickFile({ save: true, defaultName: 'a.zip' }), '/home/a/a.zip')

  // zenity 没装（ENOENT）时换 kdialog；用户取消（退出码 1）返回空串
  const calls = []
  const kdialog = new LinuxFileManager({
    home: '/home/a', env: {}, existsSync: () => true,
    execFile(command, args, options, callback) {
      calls.push(command)
      const done = typeof options === 'function' ? options : callback
      if (command === 'zenity') done(Object.assign(new Error('not found'), { code: 'ENOENT' }), '', '')
      else done(null, '/home/a/项目\n', '')
    },
  })
  assert.equal(await kdialog.pickDirectory('/home/a'), '/home/a/项目')
  assert.deepEqual(calls, ['zenity', 'kdialog'])
  const canceled = spy(LinuxFileManager, { error: Object.assign(new Error('canceled'), { code: 1 }) })
  assert.equal(await canceled.fm.pickDirectory(), '')
})

test('没有专门实现的平台：xdg-open 那条路能走，对话框和自启如实报不支持', async () => {
  const posix = new PosixFileManager()
  await assert.rejects(posix.pickDirectory(), /目录选择在当前平台不可用/)
  await assert.rejects(posix.pickFile(), /文件选择在当前平台不可用/)
  await assert.rejects(posix.setAutoStart(true), /开机自启在当前平台不可用/)
  // 关掉自启不该报错：本来就没开过
  await posix.setAutoStart(false)
  assert.equal(await posix.autoStartEnabled(), false)
})

test('核心包同时带三套文件管理实现，运行时按平台选', async () => {
  const out = mkdtempSync(join(tmpdir(), 'dsh-filemanager-pack-'))
  try {
    await copyAppFiles(out)
    assert.ok(existsSync(join(out, 'filemanager.js')), '选实现的入口')
    assert.ok(existsSync(join(out, 'filemanager-base.js')), '契约基类')
    assert.ok(existsSync(join(out, 'filemanager-mac.js')), 'mac 实现随核心包发')
    assert.ok(existsSync(join(out, 'filemanager-windows.js')), 'Windows 实现随核心包发')
    assert.ok(existsSync(join(out, 'filemanager-linux.js')), 'Linux 实现随核心包发')
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})
