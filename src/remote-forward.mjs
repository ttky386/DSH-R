import { connect } from 'node:net'
import { createServer, request } from 'node:http'

const [listenHost, listenPortText, targetHost, targetPortText] = process.argv.slice(2)
const listenPort = Number(listenPortText)
const targetPort = Number(targetPortText)
if (!listenHost || !Number.isInteger(listenPort) || listenPort <= 0 || listenPort > 65535
  || !targetHost || !Number.isInteger(targetPort) || targetPort <= 0 || targetPort > 65535) {
  console.error('usage: remote-forward.mjs <listen-host> <listen-port> <target-host> <target-port>')
  process.exit(2)
}

function authority(host, port) {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]:${port}` : `${host}:${port}`
}

function targetOrigin() {
  return `http://${authority(targetHost, targetPort)}`
}

function sourceOrigin(hostHeader) {
  return `http://${String(hostHeader || authority(listenHost, listenPort))}`
}

function proxiedHeaders(headers, hostHeader) {
  const next = { ...headers }
  // 这是 DSH-X 在同一台 Linux 上的唯一内层访问者，不是公网转发链。去掉 forwarded
  // 标记并把同源头改成回环，插件的安全围栏才能把请求识别为远端本机浏览器。
  for (const name of ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'x-real-ip', 'cf-connecting-ip']) delete next[name]
  next.host = authority(targetHost, targetPort)
  const externalOrigin = sourceOrigin(hostHeader)
  const internalOrigin = targetOrigin()
  if (typeof next.origin === 'string' && next.origin.replace(/\/$/, '') === externalOrigin) next.origin = internalOrigin
  if (typeof next.referer === 'string' && next.referer.startsWith(`${externalOrigin}/`)) {
    next.referer = `${internalOrigin}${next.referer.slice(externalOrigin.length)}`
  }
  return next
}

function rewriteLocation(value, hostHeader) {
  const text = String(value || '')
  const internalOrigin = targetOrigin()
  if (!text.startsWith(internalOrigin)) return text
  return `${sourceOrigin(hostHeader)}${text.slice(internalOrigin.length)}`
}

const server = createServer((clientRequest, clientResponse) => {
  const hostHeader = clientRequest.headers.host
  const inner = request({
    host: targetHost,
    port: targetPort,
    method: clientRequest.method,
    path: clientRequest.url,
    headers: proxiedHeaders(clientRequest.headers, hostHeader),
  }, (innerResponse) => {
    const headers = { ...innerResponse.headers }
    if (headers.location) headers.location = rewriteLocation(headers.location, hostHeader)
    if (headers.refresh) headers.refresh = rewriteLocation(headers.refresh, hostHeader)
    clientResponse.writeHead(innerResponse.statusCode || 500, headers)
    innerResponse.pipe(clientResponse)
  })
  inner.on('error', (error) => {
    if (!clientResponse.headersSent) clientResponse.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    clientResponse.end(`DSH-X remote forward failed: ${error.message}\n`)
  })
  // 浏览器取消文件上传时 Fetch/Chromium 会销毁请求，但 pipe 在 source close 时只会 end
  // destination。这里显式断开内层请求，让远端 file-upload 尽快停止接收而不是等到 EOF。
  clientRequest.on('error', () => inner.destroy())
  clientRequest.on('close', () => {
    if (!clientRequest.complete) inner.destroy()
  })
  clientRequest.pipe(inner)
})

server.on('upgrade', (clientRequest, clientSocket, clientHead) => {
  const headers = proxiedHeaders(clientRequest.headers, clientRequest.headers.host)
  const lines = [`${clientRequest.method} ${clientRequest.url} HTTP/1.1`]
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) for (const item of value) lines.push(`${name}: ${item}`)
    else if (value !== undefined) lines.push(`${name}: ${value}`)
  }
  lines.push('', '')
  const innerSocket = connect({ host: targetHost, port: targetPort })
  const fail = () => {
    if (!clientSocket.destroyed) {
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
      clientSocket.destroy()
    }
    innerSocket.destroy()
  }
  innerSocket.on('error', fail)
  clientSocket.on('error', () => innerSocket.destroy())
  innerSocket.on('connect', () => {
    innerSocket.write(lines.join('\r\n'))
    if (clientHead?.length) innerSocket.write(clientHead)
    innerSocket.pipe(clientSocket)
    clientSocket.pipe(innerSocket)
  })
})

server.on('clientError', (_error, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
})
server.on('error', (error) => {
  console.error(error.message)
  process.exit(1)
})
server.listen(listenPort, listenHost)
