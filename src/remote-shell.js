import { execFile, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { remoteIdentityFile, shellQuote, sshArgs } from './remote-launch.js'

const execFileAsync = promisify(execFile)
const PTY_HELPER = fileURLToPath(new URL('./remote-pty.py', import.meta.url))
const ptyHelpers = new Map()

const shells = new Map()
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

function sshBinary() {
  return process.platform === 'win32' ? 'ssh.exe' : 'ssh'
}

function run(target, args, timeout = 20_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(sshBinary(), [...sshArgs(target), ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('远端 Shell 命令超时'))
    }, timeout)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(stdout)
      else reject(new Error(stderr.trim() || stdout.trim() || `SSH 退出码 ${code}`))
    })
  })
}

function scpBinary() {
  return process.platform === 'win32' ? 'scp.exe' : 'scp'
}

async function ensureRemotePtyHelper(target) {
  const source = await readFile(PTY_HELPER, 'utf8')
  const digest = createHash('sha256').update(source).digest('hex')
  const identityFile = remoteIdentityFile(target)
  const key = `${target.user}@${target.host}:${target.sshPort}:${identityFile}:${digest}`
  if (ptyHelpers.get(key) === true) return
  const remoteFile = '~/.dsh-x-remote/lib/remote-pty.py'
  const check = await run(target, [`if [ -f ${remoteFile} ] && [ "$(sha256sum ${remoteFile} | cut -d' ' -f1)" = '${digest}' ]; then printf SYNC; else printf MISSING; fi`])
  if (check.trim() !== 'SYNC') {
    await run(target, ['mkdir', '-p', '~/.dsh-x-remote/lib'])
    await execFileAsync(scpBinary(), [
      '-P', String(target.sshPort),
      ...(identityFile ? ['-i', identityFile] : []),
      ...(identityFile ? ['-o', 'IdentitiesOnly=yes'] : []),
      '-o', 'ConnectTimeout=10',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'BatchMode=yes',
      PTY_HELPER,
      `${target.user}@${target.host}:~/.dsh-x-remote/lib/.remote-pty.py.new`,
    ], { windowsHide: true, timeout: 30_000 })
    await run(target, ['chmod', '700', '~/.dsh-x-remote/lib/.remote-pty.py.new', '&&', 'mv', '-f', '~/.dsh-x-remote/lib/.remote-pty.py.new', remoteFile])
  }
  ptyHelpers.set(key, true)
}

function ptySocket(name) {
  return `~/.dsh-x-remote/shells/${name}.sock`
}

async function ensurePty(target, name, { cols, rows, cwd = '' }) {
  const fixed = /^dshx_[a-f0-9]{12}$/.test(name)
  if (!fixed) throw new Error('远端 Shell 会话名不合法')
  const dimensions = [
    Math.max(20, Math.min(500, Number(cols) || 100)),
    Math.max(6, Math.min(200, Number(rows) || 30)),
  ]
  await ensureRemotePtyHelper(target)
  const socket = ptySocket(name)
  try {
    await run(target, ['python3', remoteCommandPath('lib/remote-pty.py'), 'control', socket, 'ping'])
    return dimensions
  } catch {
    await run(target, ['mkdir', '-p', '~/.dsh-x-remote/shells', '~/.dsh-x-remote/logs'])
    const command = [
      'setsid', '-f', 'python3', remoteCommandPath('lib/remote-pty.py'), 'server',
      socket, cwd ? shellQuote(cwd) : '$HOME', String(dimensions[0]), String(dimensions[1]),
      `>$HOME/.dsh-x-remote/logs/pty-${name}.log 2>&1 </dev/null &`,
    ].join(' ')
    await run(target, [command])
    await run(target, ['python3', remoteCommandPath('lib/remote-pty.py'), 'control', socket, 'ping'])
    return dimensions
  }
}

function remoteCommandPath(relative) {
  return `$HOME/.dsh-x-remote/${relative}`
}

export function createRemoteShellSession(target, { cols = 100, rows = 30, cwd = '', label = 'Shell' } = {}) {
  const name = `dshx_${randomBytes(6).toString('hex')}`
  const token = randomBytes(24).toString('base64url')
  const id = randomBytes(8).toString('hex')
  const identityFile = remoteIdentityFile(target)
  const metadata = {
    id,
    token,
    sessionName: name,
    target: { host: target.host, user: target.user, sshPort: target.sshPort, ...(identityFile ? { identityFile } : {}) },
    cwd,
    label: String(label || 'Shell').slice(0, 64),
    createdAt: Date.now(),
  }
  const events = new EventEmitter()
  const session = { ...metadata, events, child: null, sockets: new Set(), dimensions: [cols, rows] }
  shells.set(token, session)
  return ensurePty(target, name, { cols, rows, cwd }).then((dimensions) => {
    session.dimensions = dimensions
    return {
      id,
      token,
      ws: `/api/remote-shell/ws?token=${encodeURIComponent(token)}`,
      name,
      cols: dimensions[0],
      rows: dimensions[1],
      label: metadata.label,
      host: target.host,
      user: target.user,
    }
  }).catch((error) => {
    shells.delete(token)
    throw error
  })
}

function encodeFrame(payload, opcode = 2) {
  const length = payload.length
  let header
  if (length < 126) header = Buffer.from([0x80 | opcode, length])
  else if (length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  return Buffer.concat([header, payload])
}

function decodeFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset]
    const second = buffer[offset + 1]
    const opcode = first & 0x0f
    const masked = Boolean(second & 0x80)
    let length = second & 0x7f
    let cursor = offset + 2
    if (length === 126) {
      if (cursor + 2 > buffer.length) break
      length = buffer.readUInt16BE(cursor)
      cursor += 2
    } else if (length === 127) {
      if (cursor + 8 > buffer.length) break
      const big = buffer.readBigUInt64BE(cursor)
      if (big > BigInt(16 * 1024 * 1024)) throw new Error('远端 Shell 数据帧过大')
      length = Number(big)
      cursor += 8
    }
    const mask = masked ? buffer.subarray(cursor, cursor + 4) : Buffer.alloc(0)
    if (masked) cursor += 4
    if (cursor + length > buffer.length) break
    const payload = buffer.subarray(cursor, cursor + length)
    if (masked) for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4]
    frames.push({ opcode, payload: Buffer.from(payload) })
    offset = cursor + length
  }
  return { frames, rest: buffer.subarray(offset) }
}

function attachSsh(session) {
  if (session.child?.exitCode === null) return
  const target = session.target
  const child = spawn(sshBinary(), [
    ...sshArgs({
      user: target.user,
      sshPort: target.sshPort,
      host: target.host,
      identityFile: target.identityFile,
    }),
    '-tt',
    'python3', remoteCommandPath('lib/remote-pty.py'),
    'client', ptySocket(session.sessionName), String(session.dimensions[0]), String(session.dimensions[1]),
  ], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  session.child = child
  const output = (chunk) => {
    for (const socket of session.sockets) socket.write(encodeFrame(chunk))
  }
  child.stdout.on('data', output)
  child.stderr.on('data', output)
  child.on('exit', () => {
    if (shells.get(session.token) === session) {
      const close = encodeFrame(Buffer.from('SSH session closed'), 8)
      for (const socket of session.sockets) socket.end(close)
      session.sockets.clear()
    }
  })
}

export async function resizeRemoteShell(token, cols, rows) {
  const session = shells.get(String(token || ''))
  if (!session) throw new Error('远端 Shell 会话已关闭')
  const dimensions = [
    Math.max(20, Math.min(500, Number(cols) || 100)),
    Math.max(6, Math.min(200, Number(rows) || 30)),
  ]
  await run(session.target, ['python3', remoteCommandPath('lib/remote-pty.py'), 'control', ptySocket(session.sessionName), 'resize', String(dimensions[0]), String(dimensions[1])])
  session.dimensions = dimensions
  return { ok: true, cols: dimensions[0], rows: dimensions[1] }
}

export function closeRemoteShell(token) {
  const session = shells.get(String(token || ''))
  if (!session) return { ok: true, alreadyClosed: true }
  shells.delete(session.token)
  session.child?.kill()
  for (const socket of session.sockets) socket.end(encodeFrame(Buffer.alloc(0), 8))
  session.sockets.clear()
  // PTY 会话是用户 Shell 的宿主；显式关闭页签才终止它，断开 DSH-X 只 detach。
  void run(session.target, ['python3', remoteCommandPath('lib/remote-pty.py'), 'control', ptySocket(session.sessionName), 'close']).catch(() => {})
  return { ok: true, id: session.id }
}

export function remoteShellSnapshot() {
  return [...shells.values()].map(({ id, sessionName, label, target, dimensions, createdAt }) => ({
    id, sessionName, label, host: target.host, user: target.user, cols: dimensions[0], rows: dimensions[1], createdAt,
  }))
}

export function shutdownRemoteShells() {
  for (const session of [...shells.values()]) {
    shells.delete(session.token)
    session.child?.kill()
    for (const socket of session.sockets) socket.destroy()
  }
}

export function handleRemoteShellUpgrade(req, socket, head) {
  const url = new URL(req.url || '/', 'http://localhost')
  const token = url.searchParams.get('token') || ''
  const session = shells.get(token)
  if (!session || req.headers.upgrade?.toLowerCase() !== 'websocket') {
    socket.write('HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n')
    socket.destroy()
    return
  }
  const key = String(req.headers['sec-websocket-key'] || '')
  const accept = createHash('sha1').update(`${key}${WS_GUID}`).digest('base64')
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${accept}\r\n\r\n`)
  if (head?.length) socket.write(encodeFrame(head))
  socket.setTimeout(0)
  session.sockets.add(socket)
  attachSsh(session)
  let buffer = Buffer.alloc(0)
  socket.on('data', (chunk) => {
    try {
      buffer = Buffer.concat([buffer, chunk])
      const decoded = decodeFrames(buffer)
      buffer = decoded.rest
      for (const frame of decoded.frames) {
        if (frame.opcode === 8) {
          socket.end(encodeFrame(Buffer.alloc(0), 8))
          return
        }
        if (frame.opcode === 9) {
          socket.write(encodeFrame(frame.payload, 10))
          continue
        }
        if (frame.opcode === 1 || frame.opcode === 2) session.child?.stdin.write(frame.payload)
      }
    } catch (error) {
      socket.end(encodeFrame(Buffer.from(error.message || 'WebSocket error'), 8))
    }
  })
  const detach = () => {
    session.sockets.delete(socket)
    if (!session.sockets.size) session.child?.kill()
  }
  socket.on('close', detach)
  socket.on('error', detach)
}
