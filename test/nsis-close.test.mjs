import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const read = (path) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8')

test('Windows 安装器检测到托盘中的 DSH-X 时走安全退出，而不是强杀进程', () => {
  const config = read('electron-builder.config.mjs')
  const installer = read('src/assets/installer.nsh')
  const main = read('shell/main.mjs')

  assert.match(config, /include: join\('src', 'assets', 'installer\.nsh'\)/)
  assert.match(installer, /!macro customInit/, 'Windows 全新安装需要统一默认目录')
  assert.match(installer, /StrCpy \$INSTDIR "D:\\dsh"/, '有 D 盘时默认安装到 D:\\dsh')
  assert.match(installer, /ReadRegStr \$R6 SHELL_CONTEXT "\$\{INSTALL_REGISTRY_KEY\}" "InstallLocation"/, '已有安装记录时优先沿用原目录')
  // nsProcess 插件在干净环境也会对不存在的进程返回“找到”（用户重启后仍被提示
  // “仍在运行”的元凶）；检测/清理只能用系统自带的 PowerShell 计数与 taskkill。
  assert.doesNotMatch(installer, /nsProcess::/, '不再调用 nsProcess 插件（注释提及不算）')
  assert.match(installer, /Get-Process -Name '\$\{DSHX_PROC_NAME\}'/, '用 PowerShell 进程计数检测，输出不受系统语言影响')
  assert.match(installer, /\$\{If\} \$R2 == 0[\s\S]{0,80}\$\{AndIf\} \$R3 U> 0/, '命令失败（退出码非 0）必须判“无进程”，否则错误码串会被当成进程数')
  assert.match(installer, /!macro customCheckAppRunning/)
  assert.match(installer, /--dshx-quit/)
  assert.match(installer, /\$\{ExitDo\}/)
  // customCheckAppRunning 会被展开进安装 Section；这里的 Return 会直接跳过后续安装。
  assert.doesNotMatch(installer, /^\s*Return\s*$/m)
  // 顺序不能反：先给安全退出 15 秒，超时才轮到 taskkill 强杀（旧版外壳不认识 --dshx-quit 也覆盖）。
  assert.ok(installer.indexOf('dshxQuitForce:') > installer.indexOf('--dshx-quit'), '强杀必须排在安全退出之后')
  assert.match(installer, /Goto dshxQuitForce/, '安全退出超时后自动进入强杀，无需用户再点一次')
  assert.match(installer, /Delete "\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}"[\s\S]{0,120}FileExists/, '退出后探测删除主程序，等 PCA/杀软放锁再继续')
  assert.match(installer, /BrokenUninstallString/, '主程序缺失的残缺旧安装要跳过坏卸载器，允许修复安装')
  assert.match(installer, /\$\{AndIfNot\} \$\{FileExists\} "\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}"/, '只有旧主程序确实不存在才绕过旧卸载器')
  assert.match(installer, /DeleteRegValue SHELL_CONTEXT "\$\{UNINSTALL_REGISTRY_KEY\}" "UninstallString"/, '跳过方式是移走 UninstallString，不是删除原目录')
  assert.match(read('electron-builder.config.mjs'), /requestedExecutionLevel: 'asInvoker'/, '显式 UAC 清单，PCA 不再锁退出的主程序')
  assert.match(main, /app\.on\('second-instance', \(_event, argv\) =>/)
  assert.match(main, /\^-\{1,2\}dshx-quit\$/)
  assert.match(main, /void quit\(\{ force: true \}\)/, '安装器触发时跳过页面确认框')
  assert.match(main, /FORCE_QUIT_TIMEOUT_MS/, '外壳侧有硬退兜底，安全退出不能变成永不退出')
  // 外壳已死时安装器拉起的 --dshx-quit 进程：只清残留的 node 子进程，不启动 UI
  assert.match(main, /forcedQuitRequest[\s\S]{0,200}?taskkill', \['\/IM', 'DSHNode\.exe', '\/F'\]/, '外壳不在时清理工收掉残留的 DSHNode.exe')

  const block = main.slice(main.indexOf("app.on('second-instance'"), main.indexOf('app.whenReady', main.indexOf("app.on('second-instance'")))
  assert.match(block, /DSHX_QUIT_ARG/)
  assert.match(block, /void quit\(\{ force: true \}\)/)
  assert.match(block, /showManager\(\)/)
})

test('dsh 子进程与外壳进程名分离：安装期硬链接 DSHNode.exe', () => {
  const installer = read('src/assets/installer.nsh')
  const platform = read('src/platform.js')
  assert.match(installer, /mklink \/H "\$INSTDIR\\DSHNode\.exe"/, '安装期创建硬链接')
  assert.match(installer, /Delete "\$INSTDIR\\DSHNode\.exe"/, '卸载/重装时清理旧链接')
  assert.match(platform, /DSHNode\.exe/, 'Windows 打包态优先用 DSHNode.exe 作为 RUNTIME_NODE')
  assert.match(platform, /dshnode\\\.exe/, '硬链接路径也要设 ELECTRON_RUN_AS_NODE，否则会弹 GUI')
})

test('关闭主窗口仍保持托盘语义，但安装器提示明确说明后台运行', () => {
  const main = read('shell/main.mjs')
  assert.match(main, /关窗口不退出：托盘还在、dsh 照常跑/)
  assert.match(main, /event\.preventDefault\(\)\s+if \(prefs\.closeToTray && tray\) mainWindow\.hide\(\)/)
  assert.match(main, /\{ label: en \? 'Quit' : '退出', click: \(\) => quit\(\) \}/)
})
