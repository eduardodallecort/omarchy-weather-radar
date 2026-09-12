#!/usr/bin/env bash
#
# The count a radar layer keeps of the tiles it is still fetching.
#
# `RadarMap` holds the crossfade until the incoming layer reports
# `contentReady`, which is `pendingTiles` reaching zero. If the count runs
# below the truth, the layer reads as ready while its tiles are still loading
# and the fade starts against an empty layer again. Nothing looks broken: the
# hold simply stops holding. The count once started at minus one per tile,
# because a tile born settled ran its change handler before it had added
# anything.
#
# This drives the real `ui/TileLayer.qml` under Qt through the situations the
# panel puts it in: built before any frame, a new frame, a frame already
# fetched, a pan, a pan back, a frame replaced in the same pass, a frame that
# is missing, and a repoint, pan and repoint in one pass. At every step the
# count has to equal the tiles actually loading, and it must never go below
# zero.
#
# Tiles are small PNGs written to a temporary directory and loaded through
# file:// URLs, so nothing reaches RainViewer. Needs `qml6`; skips without it,
# and RADAR_REQUIRE_QS turns the skip into a failure, which is what CI sets.

set -uo pipefail

cd "$(dirname "$0")/.."
plugin=$PWD

qml=$(command -v qml6 || command -v /usr/lib/qt6/bin/qml || true)
if [[ -z $qml ]]; then
  if [[ -n ${RADAR_REQUIRE_QS:-} ]]; then
    echo "RADAR_REQUIRE_QS is set and there is no qml6 on PATH" >&2
    exit 1
  fi
  echo "no qml6 on PATH; skipping (set RADAR_REQUIRE_QS to make this fatal)"
  exit 0
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

failures=0
check() {
  local label=$1 expected=$2 actual=$3
  if [[ $expected == "$actual" ]]; then
    printf '  ok    %s\n' "$label"
  else
    printf '  FAIL  %s (expected %s, got %s)\n' "$label" "$expected" "$actual"
    failures=$((failures + 1))
  fi
}

# The layer imports its projection by relative path, so the tree is staged
# the way the plugin lays it out.
mkdir -p "$work/ui" "$work/lib"
cp "$plugin/ui/TileLayer.qml" "$work/ui/"
cp "$plugin/lib/TileMath.js" "$work/lib/"

# Three frames of one translucent 256 px tile, hard-linked across every
# position the probe's view can reach at zoom 7. Frame 7 is never written,
# which is what makes it the missing one.
python3 - "$work" <<'PY'
import os, struct, sys, zlib
work = sys.argv[1]
def chunk(kind, data):
    return (struct.pack(">I", len(data)) + kind + data
            + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff))
row = b"\x00" + bytes((40, 120, 220, 160)) * 256
png = (b"\x89PNG\r\n\x1a\n"
       + chunk(b"IHDR", struct.pack(">IIBBBBB", 256, 256, 8, 6, 0, 0, 0))
       + chunk(b"IDAT", zlib.compress(row * 256)) + chunk(b"IEND", b""))
open(f"{work}/tile.png", "wb").write(png)
for frame in range(3):
    os.makedirs(f"{work}/frames/{frame}")
    for x in range(56, 72):
        for y in range(56, 72):
            os.link(f"{work}/tile.png", f"{work}/frames/{frame}/7_{x}_{y}.png")
PY

cat > "$work/probe.qml" <<'PROBE'
import QtQuick
import "ui"

Item {
  id: harness
  width: 900
  height: 600

  function report(line) { console.log("PROBE " + line) }

  property int frame: -1
  property int lowest: 0

  function tileUrl(z, x, y) {
    if (frame < 0) return ""
    return Qt.resolvedUrl("frames/" + frame + "/" + z + "_" + x + "_" + y + ".png")
  }

  TileLayer {
    id: layer
    anchors.fill: parent
    zoom: 7
    centerLatitude: 0
    centerLongitude: 0
    tileUrlFor: harness.tileUrl
    revision: harness.frame
    onPendingTilesChanged: if (pendingTiles < harness.lowest) harness.lowest = pendingTiles
  }

  // What the count is supposed to be: the tiles with a source that have not
  // finished loading.
  function loading() {
    var n = 0
    for (var i = 0; i < layer.children.length; i++) {
      var tile = layer.children[i]
      if (tile.status === undefined) continue
      if (String(tile.source) !== "" && tile.status === Image.Loading) n++
    }
    return n
  }

  function tiles() {
    var n = 0
    for (var i = 0; i < layer.children.length; i++) {
      if (layer.children[i].status !== undefined) n++
    }
    return n
  }

  function record(label) {
    report(label + "|" + layer.pendingTiles + "|" + loading() + "|" + layer.contentReady + "|" + tiles())
  }

  // Each step changes the layer and records the count in the same pass, which
  // is the moment RadarMap reads it; the next step waits until nothing is
  // loading and records the settled count first.
  property var steps: [
    ["built before any frame", function() {}],
    ["a new frame", function() { harness.frame = 0 }],
    ["another new frame", function() { harness.frame = 1 }],
    ["a frame fetched before", function() { harness.frame = 0 }],
    ["a pan", function() { layer.centerLongitude = 3 }],
    ["a pan back onto fetched tiles", function() { layer.centerLongitude = 0 }],
    ["a frame replaced by none in the same pass", function() { harness.frame = 2; harness.frame = -1 }],
    ["a missing frame", function() { harness.frame = 7 }],
    ["a repoint, pan and repoint in one pass", function() {
      harness.frame = 1
      layer.centerLongitude = 1.5
      harness.frame = 2
    }]
  ]
  property int next: 0

  Timer {
    interval: 20
    repeat: true
    running: true
    onTriggered: {
      if (harness.loading() > 0) return
      if (harness.next > 0) harness.record(harness.steps[harness.next - 1][0] + ", settled")
      if (harness.next === harness.steps.length) {
        harness.report("lowest|" + harness.lowest)
        harness.report("done")
        Qt.quit()
        return
      }
      var step = harness.steps[harness.next++]
      step[1]()
      harness.record(step[0] + ", as it starts")
    }
  }

  // Without it a tile stuck loading would hang the job rather than fail it.
  Timer {
    interval: 60000
    running: true
    onTriggered: { harness.report("timeout|" + harness.loading()); Qt.quit() }
  }
}
PROBE

# Offscreen unconditionally: a desktop session sets QT_QPA_PLATFORM to
# wayland, and the probe would open a real window over whatever is there.
out=$(cd "$work" && QT_QPA_PLATFORM=offscreen QT_FORCE_STDERR_LOGGING=1 \
      timeout 90 "$qml" probe.qml 2>&1 | sed -n 's/.*PROBE //p')

if ! printf '%s\n' "$out" | grep -qx done; then
  echo "  FAIL  the probe did not finish" >&2
  printf '%s\n' "$out" >&2
  exit 1
fi

while IFS='|' read -r label pending loading ready count; do
  [[ -z ${count:-} ]] && continue
  check "$label: counts the $loading of $count tiles loading" "$loading" "$pending"
  check "$label: ready only when nothing is loading" \
    "$([[ $loading == 0 ]] && echo true || echo false)" "$ready"
done <<< "$out"

lowest=$(printf '%s\n' "$out" | sed -n 's/^lowest|//p')
check "the count never goes below zero" "0" "$lowest"

echo
if (( failures > 0 )); then
  echo "tile count: $failures check(s) failed"
  exit 1
fi
echo "tile count: all checks passed"
