#!/usr/bin/env python3
# Real-time lightning strikes from the Blitzortung.org community network,
# printed one per line as "<latitude> <longitude> <epoch milliseconds>".
#
# The service runs this only while the map is open and stops it on close. It
# speaks just enough WebSocket to subscribe and read, using nothing outside the
# standard library, so the plugin still installs nothing. Blitzortung's feed
# is compressed with LZW over code points; decode() undoes that.
#
# Blitzortung data is for private, non-commercial use.

import base64, collections, json, os, random, socket, ssl, struct, sys, time

HOSTS = ["ws1.blitzortung.org", "ws7.blitzortung.org", "ws8.blitzortung.org"]


def decode(data):
    if not data:
        return ""
    table = {}
    chars = list(data)
    current = chars[0]
    previous = current
    out = [current]
    code = 256
    for ch in chars[1:]:
        n = ord(ch)
        if n < 256:
            entry = ch
        elif n in table:
            entry = table[n]
        else:
            entry = previous + current
        out.append(entry)
        current = entry[0]
        table[code] = previous + current
        code += 1
        previous = entry
    return "".join(out)


class Feed:
    def __init__(self, host):
        raw = socket.create_connection((host, 443), timeout=20)
        self.sock = ssl.create_default_context().wrap_socket(raw, server_hostname=host)
        self.buf = b""
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall((
            f"GET / HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\n"
            f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\nOrigin: https://map.blitzortung.org\r\n\r\n"
        ).encode())
        while b"\r\n\r\n" not in self.buf:
            self._fill()
        head, self.buf = self.buf.split(b"\r\n\r\n", 1)
        if b" 101 " not in head.split(b"\r\n", 1)[0]:
            raise OSError("handshake refused")
        self.send(0x1, b'{"a":111}')

    def _fill(self):
        chunk = self.sock.recv(65536)
        if not chunk:
            raise OSError("closed")
        self.buf += chunk

    def _take(self, n):
        while len(self.buf) < n:
            self._fill()
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def send(self, opcode, payload):
        mask = os.urandom(4)
        n = len(payload)
        head = bytes([0x80 | opcode])
        if n < 126:
            head += bytes([0x80 | n])
        elif n < 65536:
            head += bytes([0x80 | 126]) + struct.pack(">H", n)
        else:
            head += bytes([0x80 | 127]) + struct.pack(">Q", n)
        body = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(head + mask + body)

    def messages(self):
        parts = b""
        while True:
            b0, b1 = self._take(2)
            n = b1 & 0x7F
            if n == 126:
                n = struct.unpack(">H", self._take(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._take(8))[0]
            payload = self._take(n)
            opcode = b0 & 0x0F
            if opcode == 0x8:
                raise OSError("closed by server")
            if opcode == 0x9:
                self.send(0xA, payload)
                continue
            if opcode in (0x1, 0x0):
                parts += payload
                if b0 & 0x80:
                    yield parts.decode("utf-8", "replace")
                    parts = b""


def main():
    delay = 2
    # The feed resends a strike as more stations report it.
    seen = collections.deque(maxlen=2000)
    seen_set = set()
    while True:
        try:
            feed = Feed(random.choice(HOSTS))
            feed.sock.settimeout(90)
            for message in feed.messages():
                delay = 2
                try:
                    strike = json.loads(decode(message))
                    lat, lon = float(strike["lat"]), float(strike["lon"])
                    ms = int(strike["time"]) // 1000000
                except (ValueError, KeyError, TypeError):
                    continue
                line = f"{lat:.4f} {lon:.4f} {ms}"
                if line in seen_set:
                    continue
                if len(seen) == seen.maxlen:
                    seen_set.discard(seen[0])
                seen.append(line)
                seen_set.add(line)
                sys.stdout.write(line + "\n")
                sys.stdout.flush()
        except BrokenPipeError:
            return
        except (OSError, ssl.SSLError):
            time.sleep(delay + random.random())
            delay = min(delay * 2, 60)


if __name__ == "__main__":
    try:
        main()
    except (KeyboardInterrupt, BrokenPipeError):
        pass
    os._exit(0)
