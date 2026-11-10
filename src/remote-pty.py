#!/usr/bin/env python3
import fcntl
import json
import os
import selectors
import signal
import socket
import struct
import sys
import termios
import time
import tty
import traceback


HEADER = struct.Struct("!IB")
DATA = 0
RESIZE = 1
CLOSE = 2
PING = 3
PONG = 4


def send(sock, kind, payload=b""):
    body = payload if isinstance(payload, bytes) else payload.encode("utf-8")
    sock.sendall(HEADER.pack(len(body), kind) + body)


def recv_exact(sock, size):
    data = b""
    while len(data) < size:
        chunk = sock.recv(size - len(data))
        if not chunk:
            raise ConnectionError("socket closed")
        data += chunk
    return data


def receive(sock):
    length, kind = HEADER.unpack(recv_exact(sock, HEADER.size))
    if length > 1024 * 1024:
        raise ConnectionError("frame too large")
    return kind, recv_exact(sock, length)


def resize(fd, cols, rows):
    winsize = struct.pack("HHHH", max(20, min(500, int(rows))), max(6, min(200, int(cols))), 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)


def server(path, cwd, cols, rows):
    if os.path.exists(path):
        os.unlink(path)
    server_sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server_sock.bind(path)
    os.chmod(path, 0o600)
    server_sock.listen(4)
    pid, master = os.forkpty()
    if pid == 0:
        os.chdir(cwd or os.path.expanduser("~"))
        os.environ["TERM"] = os.environ.get("TERM", "xterm-256color")
        shell = os.environ.get("SHELL") or "/bin/bash"
        os.execv(shell, [shell, "-l"])
        raise SystemExit(127)
    resize(master, cols, rows)

    clients = {}
    buffers = {}
    selector = selectors.DefaultSelector()
    selector.register(server_sock, selectors.EVENT_READ, "accept")
    selector.register(master, selectors.EVENT_READ, "master")

    def broadcast(payload):
        for client in list(clients):
            try:
                send(client, DATA, payload)
            except OSError:
                drop(client)

    def drop(client):
        try:
            selector.unregister(client)
        except KeyError:
            pass
        try:
            client.close()
        except OSError:
            pass
        clients.pop(client, None)
        buffers.pop(client, None)

    alive = True
    while alive:
        for key, _ in selector.select():
            if key.data == "accept":
                client, _ = server_sock.accept()
                selector.register(client, selectors.EVENT_READ, "client")
                clients[client] = True
            elif key.data == "master":
                try:
                    data = os.read(master, 65536)
                except OSError:
                    data = b""
                if not data:
                    alive = False
                    break
                broadcast(data)
            else:
                client = key.fileobj
                try:
                    data = client.recv(65536)
                except OSError:
                    data = b""
                if not data:
                    drop(client)
                    continue
                buffers[client] = buffers.get(client, b"") + data
                try:
                    while len(buffers.get(client, b"")) >= HEADER.size:
                        buffer = buffers[client]
                        length, kind = HEADER.unpack_from(buffer)
                        if len(buffer) < HEADER.size + length:
                            break
                        payload = buffer[HEADER.size:HEADER.size + length]
                        buffers[client] = buffer[HEADER.size + length:]
                        if kind == DATA:
                            os.write(master, payload)
                        elif kind == RESIZE:
                            size = json.loads(payload.decode("utf-8"))
                            resize(master, size.get("cols", 100), size.get("rows", 30))
                        elif kind == CLOSE:
                            alive = False
                        elif kind == PING:
                            send(client, PONG)
                except (OSError, ValueError):
                    drop(client)
    try:
        # 登录 shell 可能按交互规则处理 SIGTERM 很慢；PTY 会话结束语义是 SIGHUP。
        os.killpg(pid, signal.SIGHUP)
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            done, _ = os.waitpid(pid, os.WNOHANG)
            if done == pid:
                break
            time.sleep(0.05)
        else:
            os.killpg(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
    except OSError:
        pass
    for client in list(clients):
        drop(client)
    selector.close()
    server_sock.close()
    os.close(master)
    try:
        os.unlink(path)
    except OSError:
        pass


def client(path, cols, rows):
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.connect(path)
    send(sock, RESIZE, json.dumps({"cols": cols, "rows": rows}).encode("utf-8"))
    old = None
    if os.isatty(0):
        old = termios.tcgetattr(0)
        tty.setraw(0)
    selector = selectors.DefaultSelector()
    selector.register(0, selectors.EVENT_READ, "stdin")
    selector.register(sock, selectors.EVENT_READ, "socket")
    running = True
    try:
        while running:
            for key, _ in selector.select():
                if key.data == "stdin":
                    data = sys.stdin.buffer.read1(65536)
                    if not data:
                        running = False
                        break
                    send(sock, DATA, data)
                else:
                    kind, payload = receive(sock)
                    if kind == DATA:
                        sys.stdout.buffer.write(payload)
                        sys.stdout.buffer.flush()
                    else:
                        running = False
                        break
    finally:
        selector.close()
        sock.close()
        if old is not None:
            termios.tcsetattr(0, termios.TCSADRAIN, old)


def control(path, action, cols=0, rows=0):
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(3)
    sock.connect(path)
    if action == "resize":
        send(sock, RESIZE, json.dumps({"cols": cols, "rows": rows}).encode("utf-8"))
    elif action == "ping":
        send(sock, PING)
        kind, _ = receive(sock)
        if kind != PONG:
            raise ConnectionError("PTY server did not pong")
    else:
        send(sock, CLOSE)
    sock.close()


if __name__ == "__main__":
    try:
        command = sys.argv[1] if len(sys.argv) > 1 else ""
        arguments = sys.argv[2:] + [""] * max(0, 4 - len(sys.argv[2:]))
        if command == "server":
            server(*arguments[:4])
        elif command == "client":
            client(*arguments[:3])
        elif command == "control":
            control(*arguments[:4])
    except Exception:
        traceback.print_exc()
        raise SystemExit(1)
