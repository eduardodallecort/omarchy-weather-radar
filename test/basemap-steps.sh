#!/usr/bin/env bash
#
# What decoding the ground costs the thread that draws the shell.
#
# The unit tests prove that decoding in steps yields the same basemap as
# decoding at once. This runs the real `Service.qml` under Quickshell and
# watches the thread while it decodes the shipped file: a timer asking to run
# every 16 ms records the longest gap between two of its ticks, which is the
# longest the bar, the panels and the lock screen would all have stood still.
#
# Read in one call, the file held that thread for over half a second on a
# fast laptop. The bound below is loose, because a runner is slower and
# noisier than a laptop, and it is still five times under that.
#
# It also checks that the layers arrive one at a time and in order, that the
# result is complete, and that nothing about it reads as a failure.
#
# Offline by construction, like test/first-run.sh: `curl` and
# `omarchy-weather-location` are replaced on PATH, so the service's own
# polling finds nothing to talk to. Needs `qs`; skips without it, and
# RADAR_REQUIRE_QS turns the skip into a failure, which is what CI sets.

set -uo pipefail

cd "$(dirname "$0")/.."
plugin=$PWD

if ! command -v qs > /dev/null 2>&1; then
  if [[ -n ${RADAR_REQUIRE_QS:-} ]]; then
    echo "RADAR_REQUIRE_QS is set and there is no qs on PATH" >&2
    exit 1
  fi
  echo "no qs on PATH; skipping (set RADAR_REQUIRE_QS to make this fatal)"
  exit 0
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

home=$work/home
mkdir -p "$home" "$work/bin" "$work/plugin" "$work/runtime"

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

# Nothing outside answers. The service treats that as any other outage.
printf '#!/usr/bin/env bash\nexit 22\n' > "$work/bin/curl"
printf '#!/usr/bin/env bash\nexit 0\n' > "$work/bin/omarchy-weather-location"
chmod +x "$work/bin/curl" "$work/bin/omarchy-weather-location"

# `qs -p` refuses to load anything above the config file's directory, so the
# real files are staged beside the probe.
cp "$plugin/Service.qml" "$work/plugin/"
cp -r "$plugin/lib" "$work/plugin/"
mkdir -p "$work/plugin/data" && cp "$plugin/data/basemap.bin" "$work/plugin/data/"

cat > "$work/plugin/probe.qml" <<'PROBE'
import QtQuick
import Quickshell

ShellRoot {
  id: harness

  function report(key, value) { console.log("PROBE " + key + "=" + value) }

  property real lastTick: 0
  property real longestGap: 0
  property real startedAt: 0
  property var arrivals: []
  property int layersSeen: 0

  Loader {
    id: serviceLoader
    source: Qt.resolvedUrl("Service.qml")
    onStatusChanged: {
      if (status === Loader.Error) { harness.report("loaded", "error"); Qt.quit() }
      if (status === Loader.Ready && item) {
        item.settings = {
          alertsEnabled: false, alertRadiusKm: 100, alertMinIntensity: "Light",
          colorScheme: "TITAN", defaultZoom: 7, smoothTiles: true,
          showSnow: true, showLabel: false
        }
        harness.startedAt = Date.now()
        item.loadBasemap()
      }
    }
  }

  // Advances only when the thread is free, which is the whole measurement.
  Timer {
    interval: 16
    repeat: true
    running: true
    onTriggered: {
      var now = Date.now()
      if (harness.lastTick > 0 && now - harness.lastTick > harness.longestGap) {
        harness.longestGap = now - harness.lastTick
      }
      harness.lastTick = now

      var s = serviceLoader.item
      if (!s) return
      var layers = s.basemap ? s.basemap.order.length : 0
      if (layers !== harness.layersSeen) {
        harness.arrivals.push(layers)
        harness.layersSeen = layers
      }
      if (s.basemapDecoder === null && (s.basemap !== null || s.basemapFailed)) done.start()
    }
  }

  Timer {
    id: done
    interval: 100
    onTriggered: {
      var s = serviceLoader.item
      harness.report("loaded", "yes")
      harness.report("failed", s.basemapFailed ? "yes" : "no")
      harness.report("layers", s.basemap ? s.basemap.order.join(",") : "")
      harness.report("arrivals", harness.arrivals.join(","))
      harness.report("elapsed-ms", Date.now() - harness.startedAt)
      harness.report("longest-gap-ms", Math.round(harness.longestGap))
      Qt.quit()
    }
  }

  // Well past anything a runner should need; without it a decoder that never
  // finished would hang the job rather than fail it.
  Timer {
    interval: 120000
    running: true
    onTriggered: { harness.report("loaded", "timeout"); Qt.quit() }
  }
}
PROBE

out=$(env HOME="$home" PATH="$work/bin:$PATH" \
      QT_QPA_PLATFORM=offscreen XDG_RUNTIME_DIR="$work/runtime" \
      timeout 150 qs -p "$work/plugin/probe.qml" 2>&1 | sed -n 's/.*PROBE //p')

value() { printf '%s\n' "$out" | sed -n "s/^$1=//p" | tail -1; }

if [[ $(value loaded) != "yes" ]]; then
  echo "  FAIL  Service.qml did not decode the basemap under Quickshell" >&2
  printf '%s\n' "$out" >&2
  exit 1
fi

check "the basemap decodes" "no" "$(value failed)"
check "every layer the file holds arrives" \
  "land-lo,land,lakes,urban,rivers,admin1,admin0,places" "$(value layers)"

# Layers arrive one at a time: the count seen by the ticking timer grows in
# more than one jump. A decoder that published only at the end would show a
# single arrival of eight.
arrivals=$(value arrivals)
check "layers arrive as they complete, not all at once" \
  "yes" "$([[ $arrivals == *,* ]] && echo yes || echo no)"

gap=$(value longest-gap-ms)
check "the thread never stalls for a tenth of a second (longest ${gap} ms)" \
  "yes" "$([[ $gap -lt 100 ]] && echo yes || echo no)"

echo
printf 'decoded in %s ms of wall time; longest stall %s ms; arrivals at %s layers\n' \
  "$(value elapsed-ms)" "$gap" "$arrivals"

if (( failures > 0 )); then
  echo "basemap steps: $failures check(s) failed"
  exit 1
fi
echo "basemap steps: all checks passed"
