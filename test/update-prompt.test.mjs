import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const html = readFileSync(fileURLToPath(new URL('../src/public/index.html', import.meta.url)), 'utf8')
const css = readFileSync(fileURLToPath(new URL('../src/public/launcher.css', import.meta.url)), 'utf8')
const start = readFileSync(fileURLToPath(new URL('../src/start.js', import.meta.url)), 'utf8')
const shellMain = readFileSync(fileURLToPath(new URL('../shell/main.mjs', import.meta.url)), 'utf8')

// dsh 是第三方插件的宿主：新版本可能让插件失效（插件市场就出过），所以升级必须先确认。
const RISK = '升级会先停掉正在运行的 dsh，再下载安装新版本。插件由第三方维护、通常滞后于 dsh，新版本可能让插件失效或页面打不开（插件市场就出过这种情况）。已装的其他版本会保留，随时可以切回。'

test('启动时不再自动弹更新弹窗', () => {
  // 页面不再读 /api/pending：那个接口是「启动时先问一句」的老路
  assert.ok(!html.includes("/api/pending'"), '页面不该再去读 /api/pending')
  assert.match(html, /let askBlocking = false/, '弹窗没打开时不该拦着启动')
  assert.match(html, /function showAsk\(update\) \{[\s\S]{0,40}?askBlocking = true/, '弹窗打开时才置位')
  // 启动器那一侧也不再带着 ?ask 打开页面、不再预查更新
  assert.ok(!start.includes('?ask=update'), '启动时不该带 ?ask 打开页面')
  assert.ok(!start.includes('pendingUpdate'), '启动时不该预查有没有更新')
})

test('首页的更新按钮只弹确认，不直接升级', () => {
  assert.match(
    html,
    /updateEl\.onclick = \(\) => \{[\s\S]{0,2500}?showAsk\(\{ dsh: \{ current: selected\(\) \|\| latest, latest \} \}\)/,
    '更新按钮打开确认弹窗',
  )
  assert.ok(!/updateEl\.onclick = async/.test(html), '更新按钮不该再直接跑升级')
  // 真正的升级动作挪进弹窗，由确认按钮触发
  assert.match(html, /async function updateToLatest\(latest\)/)
  assert.match(html, /await updateToLatest\(update\.dsh\.latest\)/)
})

test('dsh 升级确认里写明了风险', () => {
  assert.ok(html.includes(`'${RISK}'`), '风险说明要作为 dsh 那一行的提示传进去')
  assert.ok(html.includes('"Upgrading stops the running dsh'), '英文界面要有对应文案')
  assert.match(css, /\.ask-risk \{/, '风险块要有自己的样式')
  assert.match(html, /t\('更新到 \{latest\}', \{ latest: update\.dsh\.latest \}\)/, '按钮文案用「更新到 x」')
})

test('启动器自更新仍然点按钮才弹', () => {
  assert.match(html, /selfUpdateEl\.onclick = \(\) => \{[\s\S]{0,500}?showAsk\(\{[\s\S]{0,300}?dsh: null,[\s\S]{0,300}?shell:/)
})

test('外壳自更新走 electron-updater，核心仍走 npm', () => {
  // 外壳：检查/下载/安装三个接口 + 弹窗里单独一行
  assert.match(html, /post\('\/api\/shell-update\/check'\)/, '关于页检查外壳更新')
  assert.match(html, /async function startShellUpdate\(btn\)/, '外壳更新有独立的下载/安装流程')
  assert.match(html, /post\('\/api\/shell-update\/download'\)/)
  assert.match(html, /post\('\/api\/shell-update\/install'\)/)
  assert.match(html, /t\('DSH-X 外壳'\)/, '弹窗里外壳和核心分开显示')
  assert.match(html, /t\('DSH-X 核心'\)/, '核心那一行不再叫「启动器」')
  // 核心：npm 的 app-download/app-apply 还在
  assert.match(html, /post\('\/api\/self\/app-download'\)/)
  assert.match(html, /post\('\/api\/self\/app-apply'\)/)
  assert.match(html, /本次只更新核心（约 12 MB 的 npm 包）/, '核心更新只换核心，不换外壳')
  // 主进程里的 updater 通过 host 暴露，SSE 事件名是 shellUpdate
  assert.match(html, /addEventListener\('shellUpdate'/)
})

test('升级正在运行的实例后要收掉「正在安装」', () => {
  // wasLive 分支启动完直接 return：漏掉 action 清理，首页会一直停在安装态、按钮全锁死
  assert.match(
    html,
    /if \(wasLive\) \{[\s\S]{0,400}?await startVersion\(latest[\s\S]{0,300}?action = ''\r?\n\s*render\(\)\r?\n\s*return/,
    '启动完返回前要先清掉 action 并重绘',
  )
})

test('自动更新只下载，安装留给用户', () => {
  // 自动下载的是 DSH-X 外壳/核心，不是 dsh 版本；装不装、什么时候重启由用户点首页「更新」决定
  const tick = shellMain.match(/async function autoUpdateTick\(\)[\s\S]*?\n\}/)
  assert.ok(tick, 'autoUpdateTick 还在')
  assert.match(tick[0], /api\/self\/app-download/, '核心更新照常自动下载')
  assert.doesNotMatch(tick[0], /app-apply/, '自动路径不应用核心更新')
  assert.doesNotMatch(shellMain, /maybeInstallShellUpdate/, '没有自动安装外壳的路径')
  assert.match(shellMain, /snapshot\.status === 'ready'\) notifyUpdateReady/, '外壳下完只提醒，不自动安装')
})
