import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import test from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULT_REMOTE_WEB_BIND, safeLaunchPresets, safeRemoteTarget, safeRemoteWebBind } from '../src/settings.js'
import { NODE_DIST_BASES, remoteIdentityFile, remoteVersionChoice, shellQuote, sshArgs } from '../src/remote-launch.js'

const html = readFileSync(fileURLToPath(new URL('../src/public/index.html', import.meta.url)), 'utf8')
const css = readFileSync(fileURLToPath(new URL('../src/public/launcher.css', import.meta.url)), 'utf8')
const server = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8')
const remoteLaunch = readFileSync(fileURLToPath(new URL('../src/remote-launch.js', import.meta.url)), 'utf8')
const remoteAgent = readFileSync(fileURLToPath(new URL('../src/remote-agent.mjs', import.meta.url)), 'utf8')
const remoteShell = readFileSync(fileURLToPath(new URL('../src/remote-shell.js', import.meta.url)), 'utf8')
const packCommon = readFileSync(fileURLToPath(new URL('../scripts/pack-common.mjs', import.meta.url)), 'utf8')

test('远程目标只保存 SSH 信息；旧 managerPort 可输入但不落盘', () => {
  assert.deepEqual(safeRemoteTarget({ host: '100.90.243.53', user: 'kali', sshPort: 22, managerPort: 3780 }), {
    host: '100.90.243.53', user: 'kali', sshPort: 22,
  })
  assert.equal(safeRemoteTarget({ host: 'DSH-Target', user: 'kali' }).host, 'dsh-target')
  assert.equal(safeRemoteTarget({ host: 'host', user: 'kali' }).identityFile, undefined)
  for (const bad of [
    { host: '', user: 'kali' },
    { host: 'host name', user: 'kali' },
    { host: 'host', user: 'bad user' },
    { host: 'host', user: 'kali', sshPort: 0 },
    { host: 'host', user: 'kali', managerPort: 70000 },
    { host: 'host', user: 'kali', identityFile: 'relative/id' },
  ]) assert.throws(() => safeRemoteTarget(bad))
})

test('远程启动项保留远端路径，坏目标整项丢弃而不是落到本机执行', () => {
  const good = { id: 'a'.repeat(16), name: 'Remote', version: 'auto', profile: 'web', port: 0, remote: { host: 'dsh-target', user: 'kali', sshPort: 22 } }
  assert.equal(safeLaunchPresets([good]).find((item) => item.id === good.id).remote.host, 'dsh-target')
  assert.equal(safeLaunchPresets([{ ...good, dshHome: '/home/kali/.dsh' }]).find((item) => item.id === good.id).dshHome, '/home/kali/.dsh')
  assert.equal(safeLaunchPresets([{ ...good, remote: { host: 'bad host', user: 'kali' } }]).some((item) => item.id === good.id), false)
})

test('SSH 参数走密钥/agent，远端代理输入按 base64 JSON stdin 传输', () => {
  assert.deepEqual(sshArgs({ host: 'dsh-target', user: 'kali', sshPort: 10022 }), [
    '-p', '10022', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'BatchMode=yes', 'kali@dsh-target',
  ])
  assert.equal(shellQuote("it's"), `'it'\\''s'`)
  assert.match(remoteLaunch, /Buffer\.from\(JSON\.stringify\(payload\), 'utf8'\)\.toString\('base64'\)/)
  assert.match(remoteLaunch, /--stdin/)
  assert.match(remoteLaunch, /runSshInput\(target/)
  assert.doesNotMatch(remoteLaunch, /remoteApi|managerPort|rewriteRemoteUrl|ensureRemoteTunnel/)
})

test('SSH 私钥输入自动纠正目录和 .pub，不存在时给明确错误', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-remote-key-'))
  const sshDir = join(root, '.ssh')
  mkdirSync(sshDir)
  writeFileSync(join(sshDir, 'id_ed25519'), 'private key')
  writeFileSync(join(sshDir, 'id_ed25519.pub'), 'public key')
  assert.equal(remoteIdentityFile({ identityFile: sshDir }), join(sshDir, 'id_ed25519'))
  assert.equal(remoteIdentityFile({ identityFile: `${join(sshDir, 'id_ed25519')}.pub` }), join(sshDir, 'id_ed25519'))
  assert.equal(remoteIdentityFile({}), '')
  assert.throws(() => remoteIdentityFile({ identityFile: join(root, 'missing') }), /SSH 私钥不可访问/)
  assert.throws(() => remoteIdentityFile({ identityFile: join(root, 'only.pub') }), /缺少同名私钥/)
  const args = sshArgs({ host: 'host', user: 'kali', sshPort: 22, identityFile: sshDir })
  assert.ok(args.includes(join(sshDir, 'id_ed25519')))
  assert.ok(args.includes('IdentitiesOnly=yes'))
})

test('远程启动项保存时写入归一化后的私钥路径', () => {
  assert.match(server, /const identityFile = remoteIdentityFile\(target\)/)
  assert.match(server, /remote: normalizedTarget/)
})

test('远端 Node 引导强制选择 linux-x64/arm64 发行包', () => {
  assert.equal(NODE_DIST_BASES.mirror, 'https://cdn.npmmirror.com/binaries/node')
  assert.match(remoteLaunch, /node-\$\{NODE_VERSION\}-linux-\$\{arch\}\.tar\.xz/)
  assert.match(remoteLaunch, /linuxArch\(info\.ARCH\)/)
  assert.match(remoteLaunch, /pnpm@\$\{PNPM_VERSION\}/)
  assert.match(remoteLaunch, /PNPM_VERSION = .+11\.27\.1/)
})

test('打包清单包含远端代理、Shell 与 PTY 助手', () => {
  for (const file of ['remote-launch.js', 'remote-agent.mjs', 'remote-shell.js', 'remote-pty.py']) {
    assert.ok(packCommon.includes(`'${file}'`), `打包清单缺少 ${file}`)
  }
})

test('远端版本选择跟随 official/rc/alpha tag', () => {
  const tags = { latest: '0.2.1-rc.2', rc: '0.2.1-rc.4', alpha: '0.2.2-alpha.2' }
  assert.equal(remoteVersionChoice({ tags, channel: 'official' }), '0.2.1-rc.2')
  assert.equal(remoteVersionChoice({ tags, channel: 'rc' }), '0.2.1-rc.4')
  assert.equal(remoteVersionChoice({ tags: { next: '0.2.1-rc.4' }, versions: ['0.2.0', '0.2.1-rc.4'], installed: ['0.2.0'], channel: 'rc', usedVersion: '0.2.0' }), '0.2.1-rc.4')
})

test('远端版本支持删除后替换，并同步本地启动项引用', () => {
  assert.match(remoteAgent, /'version-replace'/)
  assert.match(remoteAgent, /case 'version-replace':[\s\S]{0,180}removeVersion\(payload\)[\s\S]{0,120}installVersion\(payload\)/, '替换必须先删当前目录再重装，且共用远端互斥锁')
  assert.match(remoteLaunch, /remoteVersionReplace/)
  assert.match(server, /action === 'replace'/)
  assert.match(server, /async function detachRemoteVersion/)
  assert.match(server, /entry\.version !== version && entry\.usedVersion !== version && entry\.prevVersion !== version/, '删除版本时同步处理钉定版本与历史缓存')
  assert.match(server, /launchPresets: await detachRemoteVersion\(target, dshHome, version\)/)
  assert.match(html, /data-replace-version=/)
  assert.match(html, /function replaceRemoteVersion/)
  assert.match(html, /post\('\/api\/remote\/versions', \{ action: 'replace', \.\.\.remoteScope, version \}\)/)
})

test('测试连接只测 SSH，远端 DSH 缺失不算 SSH 失败', () => {
  const bodyAt = server.indexOf("const body = req.method === 'POST' ? await readJson(req) : {}", server.indexOf('async function handleApi'))
  const testAt = server.indexOf("'/api/remote-launch/test'", bodyAt + 1)
  assert.ok(bodyAt >= 0 && testAt > bodyAt, '远程接口必须在 body 初始化之后，避免 TDZ')
  const block = server.slice(testAt, server.indexOf("'/api/remote/environment'", testAt))
  assert.match(block, /remoteSshProbe\(target\)/)
  assert.doesNotMatch(block, /remoteApi|\/api\/ping|versions\/check/)
  assert.match(html, /正在测试 SSH…/)
  assert.match(html, /SSH 连接正常/)
})

test('远端生命周期直接运行 DSH，按 PID/进程组停止且不按进程名杀', () => {
  for (const text of ['/api/remote/environment', '/api/remote/versions', '/api/remote/profiles', '/api/remote-launch/start', '/api/remote-launch/stop']) {
    assert.ok(server.includes(`'${text}'`), `服务端缺少 ${text}`)
  }
  assert.match(remoteAgent, /dshEntry\(version\), profile, '--host', effectiveHost/)
  assert.match(remoteAgent, /processTreePids\(state\.pid\)/)
  assert.match(remoteAgent, /process\.kill\(pid, 'SIGTERM'\)/)
  assert.match(remoteAgent, /MUTATING_OPERATIONS/)
  assert.match(remoteAgent, /acquireMutationLock/)
  assert.doesNotMatch(remoteAgent, /!entry\.name\.startsWith\('\.'\) \|\| !\/\^\\d\+\$\/\.test\(entry\.name\)/)
  assert.match(remoteAgent, /starttime/)
  assert.doesNotMatch(remoteAgent, /killall|pkill/)
  assert.doesNotMatch(remoteAgent, /managerPort|3780/)
})

test('远端绑定地址与本地 Web 绑定分离，默认 0.0.0.0', () => {
  assert.equal(DEFAULT_REMOTE_WEB_BIND, '0.0.0.0')
  assert.equal(safeRemoteWebBind(undefined), '0.0.0.0')
  assert.equal(safeRemoteWebBind('127.0.0.1'), '127.0.0.1')
  assert.equal(safeRemoteWebBind('100.90.243.53'), '100.90.243.53')
  assert.throws(() => safeRemoteWebBind('example.com'))
  assert.match(html, /id="remoteWebBindMode"/)
  assert.match(html, /id="remoteWebBindAddress"/)
  assert.match(html, /remoteWebBindEl|remoteWebBind/)
  assert.match(css, /#remoteWebBindMode/)
})

test('远程启动项编辑器使用远端版本下拉，且版本管理安装后同步刷新', () => {
  assert.match(html, /<select id="launchRemoteVersion"/)
  assert.doesNotMatch(html, /<input id="launchRemoteVersion"/)
  assert.match(html, /#launchRemoteVersion/)
  assert.match(html, /function paintRemoteLaunchVersions\(preferred = 'auto'\)/)
  assert.match(html, /async function refreshRemoteLaunchVersions\(preferred = 'auto'\)/)
  assert.match(html, /post\('\/api\/remote\/versions', \{\s*\n\s*action: 'list',\s*\n\s*remote,\s*\n\s*dshHome: launchRemoteHomeEl\.value\.trim\(\),\s*\n\s*updateChannel: draftLaunchChannel\(\),/)
  assert.match(html, /void refreshRemoteLaunchVersions\(entry\.version \|\| 'auto'\)/)
  assert.match(html, /await refreshRemoteLaunchVersions\(launchRemoteVersionEl\.value \|\| 'auto'\)/)
  assert.match(html, /installed\.includes\(version\) \? t\('已装'\)/)
  assert.match(html, /version === latest \? t\('最新'\)/)
  assert.match(html, /launchRemoteVersionEl\.value = all\.includes\(pinned\) \? pinned : 'auto'/)
})

test('远程 Web 用远端 reverse-forward 通用适配 loopback-only 插件', () => {
  assert.match(remoteAgent, /const forwardHost = bind === '0\.0\.0\.0' && payload\.publicHost \? payload\.publicHost : ''/)
  assert.match(remoteAgent, /const effectiveHost = forwardHost \? '127\.0\.0\.1' : concreteBindHost\(bind, payload\.publicHost\)/)
  assert.match(remoteAgent, /FORWARD_FILE, forwardHost, String\(state\.port\), '127\.0\.0\.1', String\(state\.port\)/)
  assert.match(remoteAgent, /ensureRemoteReverseForwardPatch\(home, profile\)/)
  assert.match(remoteAgent, /requirePairingForLan: false/)
  assert.match(remoteAgent, /function forwarderAlive\(state\)/)
  assert.match(remoteAgent, /forwarderAlive: forwarderAlive\(state\)/)
  assert.match(remoteLaunch, /\.\/remote-forward\.mjs/)
  assert.match(packCommon, /'remote-forward\.mjs'/)
  // 通用反向转发不改成开放 CORS；第三方插件在内层仍按 loopback 安全模型运行。
  assert.doesNotMatch(remoteAgent, /Access-Control-Allow-Origin/i)
})

test('远程 Profile 管理支持配置、依赖、插件、MCP 和技能且不读取本地 Profile', () => {
  for (const text of [
    'plugin-list', 'plugin-install', 'plugin-remove', 'dependency-repair',
    'mcp-save', 'mcp-remove', 'skills-create', 'skills-remove',
  ]) assert.ok(remoteAgent.includes(`'${text}'`), `远端代理缺少 ${text}`)
  assert.match(server, /\/api\/remote\/profiles\/plugins/)
  assert.match(server, /\/api\/remote\/profiles\/mcp/)
  assert.match(server, /\/api\/remote\/profiles\/skills/)
  assert.match(remoteAgent, /safeProfileDir\(payload, payload\.profile\)/)
  assert.match(remoteAgent, /confirmPath/)
  assert.match(remoteAgent, /__DSHX_REDACTED__/)
  assert.match(html, /id="profileTarget"/)
  assert.match(html, /id="remoteConfigContent"/)
  assert.match(html, /id="remotePluginList"/)
  assert.match(html, /id="remoteMcpList"/)
  assert.match(html, /id="remoteSkillList"/)
})

test('远程 Shell 是桌面端完整 PTY，并保留会话/resize/TUI 能力', () => {
  for (const text of ['/api/remote-shell/open', '/api/remote-shell/resize', '/api/remote-shell/close', 'handleRemoteShellUpgrade']) {
    assert.ok(server.includes(text), `服务端缺少 ${text}`)
  }
  assert.match(html, /vendor\/xterm\/xterm\.js/)
  assert.match(html, /new window\.Terminal\(/)
  assert.match(html, /WebSocket\(/)
  assert.match(html, /远程 Shell 仅在 DSH-X 桌面端可用/)
  assert.match(css, /\.remote-terminal-wrap/)
  assert.doesNotMatch(remoteShell, /pushLog/)
})

test('远程实例默认融入内部标签、托盘和首页状态，不走浏览器优先路径', () => {
  assert.match(server, /function remoteTabTarget/)
  assert.match(server, /remoteRuntimeStates/)
  assert.match(server, /refreshRemoteRuntimeStates/)
  assert.match(server, /remoteTabTarget\(remoteEntry/)
  assert.match(server, /row\.preset\?\.remote/)
  assert.match(server, /const trayInstances = \[/, '托盘状态要合并本机与远程实例')
  assert.match(server, /row\.preset\?\.remote && row\.target\?\.url && row\.status === 'running'/, '运行中的远程目标必须进入外壳标签跟踪列表')
  assert.match(server, /instances=\$\{JSON\.stringify\(trayInstances\)\}/, '/api/tray 使用合并后的实例列表')
  assert.match(server, /remoteLaunches:/)
  assert.match(html, /remoteLaunchStates\.clear\(\)/)
  assert.match(html, /data\.remoteLaunches/)
  assert.match(html, /await openInstance\(data\.url, \{ internal: true \}\)/)
  assert.match(server, /openModeInternal: internalTabsHost\(\)/)
  assert.match(server, /const DEFAULT_OPEN_MODE = 'internal'|let OPEN_MODE = safeOpenMode/)
  assert.match(server, /function openManagedUrl/)
  assert.match(server, /只能打开本机地址或 DSH-X 管理的远程实例/)
  assert.match(server, /openManagedUrl\(body\.url, body\.internal === true \? 'internal' : OPEN_MODE\)/)
  assert.match(server, /body\.internal === true \? 'internal' : OPEN_MODE/)
  assert.doesNotMatch(server, /http:\/\/\$\{entry\.remote\.host\}:\$\{listener\.port\}/)
})

test('远端状态以进程、监听和 HTTP 首跳为准；从未启动不是错误', () => {
  assert.match(remoteAgent, /async function probeState/)
  assert.match(remoteAgent, /waitUntilHttpReady/)
  assert.match(remoteAgent, /REMOTE_DSH_HTTP_NOT_READY/)
  assert.match(remoteAgent, /reason: 'no-record'/)
  assert.match(remoteAgent, /listener-not-found/)
  assert.match(remoteAgent, /authentication-required/)
  assert.match(server, /probe: state\.probe/)
  assert.match(server, /state\?\.probe\?\.ok !== false/)
  assert.match(server, /runtime\.probe\?\.ok !== false/)
  assert.match(server, /state\.probe\?\.ok === false/)
  assert.match(server, /state\?\.\managed === false/)
  assert.match(remoteAgent, /old\.managed === false \? await probeState\(old\) : await waitUntilHttpReady\(old\)/)
  assert.match(html, /data-service-id/)
  assert.match(html, /checkRemoteLaunchService/)
  assert.match(html, /live\.probe && !live\.probe\.ok/)
})

test('远端代理失败时保留结构化错误码，不能被包装成 SSH 失败', () => {
  assert.match(remoteLaunch, /function remoteAgentErrorFrom/)
  assert.match(remoteLaunch, /const agentError = remoteAgentErrorFrom\(`\$\{error\.stderr \|\| ''\}\\n\$\{error\.stdout \|\| ''\}`\)/)
  assert.match(remoteLaunch, /if \(agentError\) throw agentError/)
  assert.match(remoteAgent, /REMOTE_DSH_TAKEOVER_REQUIRED/)
  assert.match(remoteAgent, /REMOTE_DSH_HTTP_NOT_READY/)
  assert.match(remoteAgent, /REMOTE_OPERATION_BUSY/)
  assert.match(server, /REMOTE_DSH_HTTP_NOT_READY/)
  assert.match(server, /REMOTE_OPERATION_BUSY/)
})

test('远程启动自动同步本机 DeepSeek Key，缺失时结构化触发一次性输入', () => {
  assert.match(server, /function localDshCredentialRef\(name\)/)
  assert.match(server, /join\(homeDir\(\), '\.credentials\.yaml'\)/)
  assert.match(server, /ensureRemoteDshCredentials\(entry, options, \{ allowMissing: allowMissingCredential === true \}\)/)
  assert.match(server, /remoteCredentialSet\(entry\.remote, entry\.dshHome \|\| '', 'DEEPSEEK_API_KEY', value, options\)/)
  assert.match(server, /REMOTE_DSH_CREDENTIAL_REQUIRED/)
  assert.match(server, /send\(res, 428, \{[\s\S]*?credentials: error\.credentials \|\| \{ refs: \[\], records: \[\] \}/)
  assert.match(server, /allowMissingCredential: body\.allowMissingCredential === true/)
  assert.match(html, /id="remoteCredentialDialog"/)
  assert.match(html, /id="remoteCredentialInput"[^>]*type="password"/)
  assert.match(html, /error\.code === 'REMOTE_DSH_CREDENTIAL_REQUIRED'/)
  assert.match(html, /allowMissingCredential = true/)
  assert.match(html, /action: 'set',[\s\S]*?name: 'DEEPSEEK_API_KEY'/)
  assert.match(html, /remoteCredentialDialogInputEl\.value = ''/)
  // 弹窗只做远端凭据输入，不允许被意外扩展成本地持久化。
  const dialogAt = html.indexOf('id="remoteCredentialDialog"')
  const dialog = html.slice(dialogAt, html.indexOf('id="skillDetailDialog"', dialogAt))
  assert.doesNotMatch(dialog, /localStorage|sessionStorage|console\./)
})

test('远端默认 dsh 目录不能改写当前管理目标，避免远程 Profile 回退本机', () => {
  assert.doesNotMatch(html, /if \(!target\.dshHome && data\.dshHome\) target\.dshHome = data\.dshHome/)
  assert.match(html, /下拉框的 option value 仍是空 dshHome/)
  assert.match(html, /const data = await post\('\/api\/remote\/profiles', \{ remote: target\.remote, dshHome: target\.dshHome \|\| '' \}\)/)
})

test('DSH-X 通过 SSH 受信通道自动完成 remote-web-ui 设备配对', () => {
  assert.match(remoteAgent, /import \{ request \} from 'node:http'/)
  assert.match(remoteAgent, /localAddress: '127\.0\.0\.1'/)
  assert.match(remoteAgent, /\/api\/pair\/status/)
  assert.match(remoteAgent, /\/api\/pair\/issue/)
  assert.match(remoteAgent, /case 'pair-status'/)
  assert.match(remoteAgent, /case 'pair-issue'/)
  assert.match(remoteAgent, /REMOTE_PAIR_PLUGIN_UNAVAILABLE/)
  assert.match(remoteAgent, /url\.hostname = address/)
  assert.match(remoteLaunch, /const agentEnsuring = new Map\(\)/)
  assert.match(remoteLaunch, /const existing = agentEnsuring\.get\(targetKey\)/)
  assert.match(remoteLaunch, /export async function remotePairStatus/)
  assert.match(remoteLaunch, /export async function remotePairIssue/)
  assert.match(server, /\/api\/remote-launch\/pair/)
  assert.match(server, /remotePairStatus\(entry\.remote, entry\.id, options\)/)
  assert.match(server, /remotePairIssue\(entry\.remote, entry\.id, entry\.remote\.host, options\)/)
  assert.match(server, /if \(remoteEntry && tab\.url !== url\) tab\.url = url/)
  assert.match(html, /post\('\/api\/remote-launch\/pair', \{ id: entry\.id, action: 'issue' \}\)/)
  assert.match(html, /if \(pair\.needed && pair\.url\) openUrl = pair\.url/)
  assert.match(html, /await openInstance\(openUrl, \{ internal: true \}\)/)
  // 一次性配对 URL 不能进设置、日志或回显给用户。
  const pairRoute = server.slice(server.indexOf("'/api/remote-launch/pair'"), server.indexOf("'/api/remote-launch/start'"))
  assert.doesNotMatch(pairRoute, /pushLog|writeFile|saveSettings/)
})

test('MCP、技能和版本管理共享本机/远程目标，不另开割裂页面', () => {
  for (const id of ['profileTarget', 'mcpProfileTarget', 'skillProfileTarget', 'remoteLogOutput']) assert.ok(html.includes(`id="${id}"`), `页面缺少 ${id}`)
  assert.match(html, /mcp: async \(\) => \{ paintProfileTargets\(\); await loadMcp\(\) \}/)
  assert.match(html, /skills: async \(\) => \{ paintProfileTargets\(\); await loadSkills\(\) \}/)
  assert.match(html, /remoteProfilePost\('\/api\/remote\/profiles\/mcp'/)
  assert.match(html, /remoteProfilePost\('\/api\/remote\/profiles\/skills'/)
  assert.match(html, /versionManageRemote/)
  assert.match(html, /paintRemoteVersionManager/)
  assert.match(remoteAgent, /case 'mcp-probe'/)
  assert.match(remoteAgent, /case 'skills-detail'/)
  assert.match(remoteAgent, /case 'skills-install'/)
  assert.match(remoteAgent, /case 'version-optimize'/)
  for (const text of ['pack-list', 'pack-install', 'pack-uninstall', 'pack-export', 'profile-recover', 'profile-recover-restore']) {
    assert.ok(remoteAgent.includes(`case '${text}'`), `远端代理缺少 ${text}`)
  }
  assert.match(server, /\/api\/remote\/profiles\/packs/)
  assert.match(server, /\/api\/remote\/profiles\/recover/)
  assert.match(html, /id="remotePackList"/)
  assert.match(html, /id="remoteProfileRecover"/)
  assert.match(remoteLaunch, /remotePackInstall|remoteProfileRecover/)
  // 远端版本管理不能用本机 installedList/runningInfo 拦截，否则本机已有/运行时会误伤远端操作。
  assert.match(html, /\(!remoteScope && installedList\(\)\.includes\(version\)\)/)
  assert.match(html, /\(!remoteScope && runningInfo\(version\)\)/)
  assert.match(html, /\(!remoteScope && state\.installing\)/)
  assert.match(server, /const remote = body\.remote === undefined \? undefined : safeRemoteTarget\(body\.remote\)[\s\S]{0,180}if \(remote\) return saveRemoteLaunchPreset/)
  assert.match(server, /action === 'optimize'/)
  assert.match(remoteAgent, /case 'version-optimize'/)
})

test('DSH 凭据只落在远端官方 credentials 文件，界面只返回状态不返回值', () => {
  for (const text of ['credentials-list', 'credentials-set', 'credentials-unset']) assert.ok(remoteAgent.includes(`case '${text}'`), `远端代理缺少 ${text}`)
  assert.match(remoteAgent, /\.credentials\.yaml/)
  assert.match(remoteAgent, /dsh-atomic-write/)
  assert.match(remoteAgent, /mode: 0o600/)
  assert.match(remoteAgent, /assertCredentialFileSafety/)
  assert.match(remoteAgent, /patchCredentialRef/)
  assert.match(remoteAgent, /refs 里已经没有条目时，标头也不能留下/)
  assert.match(remoteLaunch, /remoteCredentialsList|remoteCredentialSet/)
  assert.match(server, /\/api\/remote\/credentials/)
  assert.match(html, /id="remoteCredentialName"/)
  assert.match(html, /id="remoteCredentialValue"/)
  assert.match(html, /不显示、不保存、不日志记录真实值/)
  const listCase = remoteAgent.slice(remoteAgent.indexOf("case 'credentials-list'"), remoteAgent.indexOf("case 'credentials-set'"))
  assert.match(listCase, /out\(\{ ok: true, file, exists: safety\.exists, permissionOk: safety\.modeOk, \.\.\.listCredentialFacts\(file\) \}\)/)
  assert.doesNotMatch(listCase, /readFileSync|resolve\(|JSON\.stringify\(.*value/i)
})
