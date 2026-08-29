#!/usr/bin/env python3
"""Small, policy-compliant OpenStreetMap tile proxy for the QML map.

Qt Quick's Image element cannot attach the identifying User-Agent required by
OpenStreetMap's standard tile service.  This loopback-only helper adds that
identity and keeps a seven-day disk cache; QML never talks to the tile service
directly.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


UPSTREAM = "https://tile.openstreetmap.org/{z}/{x}/{y}.png"
USER_AGENT = (
    "omarchy-weather-radar/0.1.2 "
    "(+https://github.com/eduardodallecort/omarchy-weather-radar)"
)
CACHE_SECONDS = 7 * 24 * 60 * 60
MAX_ZOOM = 19
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
TILE_PATH = re.compile(r"^/(\d+)/(\d+)/(\d+)\.png$")


def parse_tile_path(path: str) -> tuple[int, int, int] | None:
    match = TILE_PATH.fullmatch(path)
    if not match:
        return None
    z, x, y = (int(value) for value in match.groups())
    if z > MAX_ZOOM or x >= 2**z or y >= 2**z:
        return None
    return z, x, y


class TileServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], cache_dir: Path):
        super().__init__(address, TileHandler)
        self.cache_dir = cache_dir
        self._locks: dict[Path, threading.Lock] = {}
        self._locks_guard = threading.Lock()

    def lock_for(self, path: Path) -> threading.Lock:
        with self._locks_guard:
            return self._locks.setdefault(path, threading.Lock())


class TileHandler(BaseHTTPRequestHandler):
    server: TileServer
    protocol_version = "HTTP/1.1"

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        tile = parse_tile_path(self.path)
        if tile is None:
            self.send_error(404)
            return

        z, x, y = tile
        cache_path = self.server.cache_dir / str(z) / str(x) / f"{y}.png"
        try:
            data = self._tile_bytes(cache_path, z, x, y)
        except (OSError, urllib.error.URLError, TimeoutError):
            self.send_error(502, "Basemap tile is temporarily unavailable")
            return

        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", f"public, max-age={CACHE_SECONDS}")
        self.end_headers()
        self.wfile.write(data)

    def _tile_bytes(self, path: Path, z: int, x: int, y: int) -> bytes:
        with self.server.lock_for(path):
            if self._fresh(path):
                return path.read_bytes()

            try:
                data = self._download(z, x, y)
                path.parent.mkdir(parents=True, exist_ok=True)
                temporary = path.with_suffix(f".tmp-{os.getpid()}-{threading.get_ident()}")
                try:
                    temporary.write_bytes(data)
                    os.replace(temporary, path)
                finally:
                    temporary.unlink(missing_ok=True)
                return data
            except (OSError, urllib.error.URLError, TimeoutError):
                # A stale map is more useful than a blank one during an outage,
                # and serving it does not create another upstream request.
                if path.is_file():
                    return path.read_bytes()
                raise

    @staticmethod
    def _fresh(path: Path) -> bool:
        try:
            return time.time() - path.stat().st_mtime < CACHE_SECONDS
        except OSError:
            return False

    @staticmethod
    def _download(z: int, x: int, y: int) -> bytes:
        request = urllib.request.Request(
            UPSTREAM.format(z=z, x=x, y=y),
            headers={"User-Agent": USER_AGENT, "Accept": "image/png"},
        )
        with urllib.request.urlopen(request, timeout=12) as response:
            data = response.read()
        if not data.startswith(PNG_SIGNATURE):
            raise OSError("upstream returned a non-PNG response")
        return data

    def log_message(self, _format: str, *args: object) -> None:
        # Tile requests are routine and would otherwise flood the shell log.
        pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--cache-dir",
        type=Path,
        default=Path.home() / ".cache" / "omarchy-weather-radar" / "osm",
    )
    args = parser.parse_args()

    server = TileServer(("127.0.0.1", 0), args.cache_dir)
    print(f"READY {server.server_port}", flush=True)
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
