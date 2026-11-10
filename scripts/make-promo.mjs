/**
 * 渲染 docs/promo.mp4。
 *
 *     node scripts/make-promo.mjs
 *
 * 画面不在这里画：docs/promo.html 暴露了 renderPromo(T)，本脚本按 1/24 秒步进调用它，
 * 每步截一帧送进 ffmpeg。这样是确定性录帧——不丢帧、不抖动，比实时录屏干净得多，
 * 而那些带回弹的缓动（Q弹）都在页面的 JS 里，改起来也就是改页面。
 *
 * 音床用纯 JS 合成，不引用任何第三方音乐，所以可以随片分发。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PAGE = join(ROOT, 'docs', 'promo.html')
const OUT = join(ROOT, 'docs', 'promo.mp4')

const W = 1920
const H = 1080
const FPS = 24
const TOTAL = 60
const SR = 44100

/** 每拍开头（秒）——和 promo.html 里的 BEATS 对齐，铃音落在这里 */
const CUTS = [0, 6, 14, 21.5, 29, 35.5, 42.5, 49.5, 55]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function cdp(port, path) {
  for (let i = 0; i < 60; i += 1) {
    try {
      return await fetch(`http://127.0.0.1:${port}${path}`).then((r) => r.json())
    } catch {
      await sleep(400)
    }
  }
  throw new Error(`CDP ${path} 连不上`)
}

function wavBuffer(samples, sampleRate) {
  const frames = samples.length / 2
  const buffer = Buffer.alloc(44 + frames * 4)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + frames * 4, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(2, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 4, 28)
  buffer.writeUInt16LE(4, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(frames * 4, 40)
  for (let i = 0; i < frames; i += 1) {
    buffer.writeInt16LE(samples[i * 2], 44 + i * 4)
    buffer.writeInt16LE(samples[i * 2 + 1], 44 + i * 4 + 2)
  }
  return buffer
}

/** 缓慢移动的和声铺底 + 每次转场一记轻铃，整体压得很低。 */
function ambientBed(seconds) {
  const total = Math.round(seconds * SR)
  const left = new Float64Array(total)
  const partials = [
    [110.0, 0.30, 0.037, 0.0],
    [164.8, 0.20, 0.053, 1.1],
    [220.0, 0.16, 0.029, 2.2],
    [329.6, 0.09, 0.043, 0.6],
  ]
  for (const [freq, level, lfo, phase] of partials) {
    const w = 2 * Math.PI * freq
    const l = 2 * Math.PI * lfo
    for (let i = 0; i < total; i += 1) {
      const t = i / SR
      left[i] += level * (0.65 + 0.35 * Math.sin(l * t + phase)) * Math.sin(w * t)
    }
  }
  for (const at of CUTS) {
    if (at <= 0.2) continue
    const start = Math.round(at * SR)
    for (let i = start; i < total; i += 1) {
      const t = (i - start) / SR
      left[i] += Math.exp(-t * 3.2) * Math.sin(2 * Math.PI * 659.3 * t) * 0.10
      left[i] += Math.exp(-t * 5.5) * Math.sin(2 * Math.PI * 987.8 * t) * 0.05
    }
  }
  const samples = new Int16Array(total * 2)
  const delay = Math.round(0.011 * SR)
  for (let i = 0; i < total; i += 1) {
    const t = i / SR
    const fade = Math.min(1, t / 2.4) * Math.min(1, Math.max(0, (seconds - t) / 3.2))
    const dry = Math.tanh(left[i] * 1.1) * 0.34 * fade
    const wet = Math.tanh((left[i - delay] || 0) * 1.1) * 0.34 * fade
    samples[i * 2] = Math.round(dry * 32767)
    samples[i * 2 + 1] = Math.round(wet * 32767)
  }
  return samples
}

async function main() {
  const chrome = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].find((p) => { try { return statSync(p).size > 0 } catch { return false } })
  if (!chrome) throw new Error('找不到 Chrome 或 Edge')

  const profile = mkdtempSync(join(tmpdir(), 'promo-'))
  const port = 9350
  const browser = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--force-device-scale-factor=1',
    `--window-size=${W},${H}`,
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    // ?still 让页面别自己播，时间由我们喂
    `${pathToFileURL(PAGE).href}?still`,
  ], { stdio: 'ignore' })

  const target = (await cdp(port, '/json')).find((t) => t.type === 'page' && t.url.includes('promo.html'))
  if (!target) throw new Error('找不到宣传片页面')

  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }))
  let id = 0
  const waiting = new Map()
  const problems = []
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.method === 'Runtime.exceptionThrown') {
      problems.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text)
    }
    if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id) }
  })
  const send = (method, params = {}) => new Promise((resolve) => {
    const myId = ++id
    waiting.set(myId, resolve)
    ws.send(JSON.stringify({ id: myId, method, params }))
  })

  await send('Runtime.enable')
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false })
  await sleep(2500)
  const ready = await send('Runtime.evaluate', { expression: 'typeof window.renderPromo', returnByValue: true })
  if (ready.result?.result?.value !== 'function') throw new Error('页面没有暴露 renderPromo')
  if (problems.length) console.log('页面报错:', problems.slice(0, 3).join(' | '))

  const frames = TOTAL * FPS
  console.log(`开始录帧：${frames} 帧 / ${TOTAL} 秒 @ ${FPS}fps`)
  const encoder = spawn('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'image2pipe', '-vcodec', 'png', '-r', String(FPS), '-i', 'pipe:0',
    '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
    join(ROOT, 'docs', 'promo-silent.mp4'),
  ], { stdio: ['pipe', 'ignore', 'inherit'] })

  const write = (buf) => new Promise((resolve) => {
    if (encoder.stdin.write(buf)) resolve()
    else encoder.stdin.once('drain', resolve)
  })

  for (let i = 0; i < frames; i += 1) {
    await send('Runtime.evaluate', { expression: `renderPromo(${(i / FPS).toFixed(4)})` })
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    await write(Buffer.from(shot.result.data, 'base64'))
    if (i % 120 === 0) console.log(`  ${i}/${frames}`)
  }
  encoder.stdin.end()
  await new Promise((resolve) => encoder.on('close', resolve))
  browser.kill()

  console.log('合成音床…')
  const wav = join(tmpdir(), 'promo-bed.wav')
  writeFileSync(wav, wavBuffer(ambientBed(TOTAL), SR))

  await new Promise((resolve, reject) => {
    const mux = spawn('ffmpeg', [
      '-y', '-loglevel', 'error',
      '-i', join(ROOT, 'docs', 'promo-silent.mp4'),
      '-i', wav,
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest',
      '-movflags', '+faststart',
      OUT,
    ], { stdio: ['ignore', 'ignore', 'inherit'] })
    mux.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg 混音失败 ${code}`))))
  })

  rmSync(join(ROOT, 'docs', 'promo-silent.mp4'), { force: true })
  rmSync(wav, { force: true })
  // 浏览器刚被杀掉时 profile 目录可能还被占着，清理失败不该让整个渲染判为失败
  try { rmSync(profile, { recursive: true, force: true }) } catch { /* 留着也无害 */ }
  console.log(`成片 ${OUT}  ${(statSync(OUT).size / 1048576).toFixed(1)} MB`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
