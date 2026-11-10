import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer as createHttpServer, request } from 'node:http'
import { createServer as createNetServer, connect } from 'node:net'
import { once } from 'node:events'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const forwardFile = fileURLToPath(new URL('../src/remote-forward.mjs', import.meta.url))
const linuxForwardOnly = process.platform === 'win32' ? 'reverse-forward 运行于远端 Linux；Windows runner 的 TCP teardown 行为不代表目标环境' : false

async function listen(server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return server.address().port
}

async function freePort() {
  const server = createNetServer()
  const port = await listen(server)
  server.close()
  await once(server, 'close')
  return port
}

async function connectRetry(port) {
  let lastError
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    try {
      return await new Promise((resolve, reject) => {
        const socket = connect({ host: '127.0.0.1', port })
        socket.once('connect', () => resolve(socket))
        socket.once('error', reject)
      })
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

test('远端 reverse-forward 把同源头改写成回环并重写 Location', async () => {
  const seen = []
  const target = createHttpServer((req, res) => {
    seen.push({ headers: req.headers, url: req.url })
    res.writeHead(200, {
      'content-type': 'application/json',
      location: `http://127.0.0.1:${target.address().port}/next`,
    })
    res.end('{"ok":true}')
  })
  const targetPort = await listen(target)
  const proxyPort = await freePort()
  const proxy = spawn(process.execPath, [forwardFile, '127.0.0.1', String(proxyPort), '127.0.0.1', String(targetPort)], { stdio: ['ignore', 'ignore', 'pipe'] })
  try {
    let response
    for (let attempt = 0; attempt < 40 && !response; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      response = await fetch(`http://127.0.0.1:${proxyPort}/api/example`, {
        headers: {
          origin: `http://127.0.0.1:${proxyPort}`,
          referer: `http://127.0.0.1:${proxyPort}/page`,
          'x-forwarded-for': '203.0.113.1',
        },
      }).catch(() => null)
    }
    assert.ok(response, 'reverse-forward 没有就绪')
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('location'), `http://127.0.0.1:${proxyPort}/next`)
    assert.equal(seen.length, 1)
    assert.equal(seen[0].headers.host, `127.0.0.1:${targetPort}`)
    assert.equal(seen[0].headers.origin, `http://127.0.0.1:${targetPort}`)
    assert.equal(seen[0].headers.referer, `http://127.0.0.1:${targetPort}/page`)
    assert.equal(seen[0].headers['x-forwarded-for'], undefined)
  } finally {
    proxy.kill()
    await once(proxy, 'exit')
    target.close()
    await once(target, 'close')
  }
})

test('远端 reverse-forward 透传 WebSocket 并改写 Origin/Host', async () => {
  const seen = []
  const target = createHttpServer()
  const targetPort = await listen(target)
  target.on('upgrade', (req, socket) => {
    seen.push(req.headers)
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nforwarded')
    socket.end()
  })
  const proxyPort = await freePort()
  const proxy = spawn(process.execPath, [forwardFile, '127.0.0.1', String(proxyPort), '127.0.0.1', String(targetPort)], { stdio: ['ignore', 'ignore', 'pipe'] })
  try {
    const socket = await connectRetry(proxyPort)
    socket.write([
      'GET /remote/ws HTTP/1.1',
      `Host: 127.0.0.1:${proxyPort}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      'Sec-WebSocket-Version: 13',
      `Origin: http://127.0.0.1:${proxyPort}`,
      'X-Forwarded-For: 203.0.113.1',
      '', '',
    ].join('\r\n'))
    const text = await new Promise((resolve, reject) => {
      const chunks = []
      socket.on('data', (chunk) => chunks.push(chunk))
      socket.on('error', reject)
      setTimeout(() => resolve(Buffer.concat(chunks).toString('utf8')), 300).unref()
    })
    socket.destroy()
    assert.match(text, /^HTTP\/1\.1 101 Switching Protocols/)
    assert.match(text, /forwarded$/)
    assert.equal(seen.at(-1).host, `127.0.0.1:${targetPort}`)
    assert.equal(seen.at(-1).origin, `http://127.0.0.1:${targetPort}`)
    assert.equal(seen.at(-1)['x-forwarded-for'], undefined)
  } finally {
    proxy.kill()
    await once(proxy, 'exit')
    target.close()
    await once(target, 'close')
  }
})

test('远端 reverse-forward 流式转发上传请求体，不在代理层攒完整文件', { skip: linuxForwardOnly }, async () => {
  const chunks = []
  let sawFirst
  const sawFirstPromise = new Promise((resolve) => { sawFirst = resolve })
  const target = createHttpServer((req, res) => {
    req.on('data', (chunk) => {
      chunks.push(chunk)
      if (chunks.length === 1) sawFirst()
    })
    req.on('end', () => res.end('uploaded'))
  })
  const targetPort = await listen(target)
  const proxyPort = await freePort()
  const proxy = spawn(process.execPath, [forwardFile, '127.0.0.1', String(proxyPort), '127.0.0.1', String(targetPort)], { stdio: ['ignore', 'ignore', 'pipe'] })
  try {
    ;(await connectRetry(proxyPort)).destroy()
    const first = Buffer.from('0'.repeat(64))
    const second = Buffer.from('1'.repeat(64))
    const outbound = request({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'POST',
      path: '/upload',
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': first.length + second.length,
      },
    })
    const responsePromise = once(outbound, 'response')
    outbound.write(first)
    await sawFirstPromise
    // 目标端已经收到第一块，才写第二块；如果 reverse-forward 先攒完整 body，这里会死锁。
    outbound.write(second)
    outbound.end()
    const [response] = await responsePromise
    assert.equal(response.statusCode, 200)
    assert.deepEqual(chunks, [first, second])
  } finally {
    proxy.kill()
    await once(proxy, 'exit')
    target.close()
    await once(target, 'close')
  }
})

test('客户端取消上传时远端请求也断开', async () => {
  let sawData
  const sawDataPromise = new Promise((resolve) => { sawData = resolve })
  let closed
  const closedPromise = new Promise((resolve) => { closed = resolve })
  const target = createHttpServer((req, res) => {
    req.once('data', sawData)
    req.once('aborted', closed)
    req.once('close', () => {
      if (req.aborted || !req.complete) closed()
    })
    res.writeHead(200)
  })
  const targetPort = await listen(target)
  const proxyPort = await freePort()
  const proxy = spawn(process.execPath, [forwardFile, '127.0.0.1', String(proxyPort), '127.0.0.1', String(targetPort)], { stdio: ['ignore', 'ignore', 'pipe'] })
  try {
    ;(await connectRetry(proxyPort)).destroy()
    const outer = request({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'POST',
      path: '/upload',
      headers: { 'content-length': 1024 * 1024 },
    })
    outer.on('error', () => {})
    outer.write(Buffer.from('0'.repeat(64)))
    await sawDataPromise
    outer.destroy()
    await closedPromise
  } finally {
    proxy.kill()
    await once(proxy, 'exit')
    target.close()
    await once(target, 'close')
  }
})
