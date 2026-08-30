#!/usr/bin/env bash
#
# What happens on a machine that has never set a weather location.
#
# The unit tests cover the pure half — an absent file reads as "unset", a name
# with no coordinates reads as "unresolved" — and pass whatever the shell does
# with those answers. This runs the real `Service.qml` under Quickshell against
# a home directory that does not exist yet, and checks the wiring.
#
# The interesting part is a gap the code can only assert in a comment. The
# location file is watched, but a watch reaches no further than the directory
# holding it, and on a fresh machine `~/.local/state/omarchy/settings/` has
# never been created — so the first location ever written is invisible to the
# watch that exists to notice it. What closes the gap is the panel calling
# `reloadLocation()` after a successful save. Nothing else would ever fire, and
# nothing but this notices if that call is removed.
#
# Offline by construction: `curl` and `omarchy-weather-location` are replaced on
# PATH. A test that reached Open-Meteo would be flaky in CI and would put this
# plugin's continuous integration on someone else's free service.
#
# Needs `qs` (Quickshell), which is why CI runs this job in an Arch container
# rather than on ubuntu-latest. Skips where there is no `qs`, so the suite still
# runs on a machine without it; RADAR_REQUIRE_QS turns that skip into a failure,
# which is what CI sets.

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
mkdir -p "$home" "$work/bin" "$work/plugin"

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

# ------------------------------------------------------------ the fake world
#
# The real omarchy-weather-location, reduced to the two lines this exercises —
# including the `mkdir -p`, because the directory not existing is the whole
# point of the test.
cat > "$work/bin/omarchy-weather-location" <<'FAKE'
#!/usr/bin/env bash
file=$HOME/.local/state/omarchy/settings/weather.json
case "$1" in
  --set)
    mkdir -p "$(dirname "$file")"
    printf '{"name":"%s","latitude":%s,"longitude":%s}\n' "$2" "${3%,*}" "${3#*,}" > "$file"
    ;;
  --clear) rm -f "$file" ;;
esac
FAKE

# Answers shaped like the real ones, so the service parses rather than fails.
# The forecast is deliberately wet enough to produce an outlook: a run where
# every response is empty would pass while proving only that nothing crashed.
cat > "$work/bin/curl" <<'FAKE'
#!/usr/bin/env bash
url=""
for arg in "$@"; do case "$arg" in https://*) url=$arg ;; esac; done
case "$url" in
  *api.open-meteo.com/v1/forecast*)
    cat <<'JSON'
[{"latitude":64.15,"longitude":-21.94,"timezone":"Atlantic/Reykjavik",
  "minutely_15":{"time":["2026-08-30T10:00","2026-08-30T10:15","2026-08-30T10:30","2026-08-30T10:45"],
                 "precipitation":[0.0,0.4,0.6,0.6],"precipitation_probability":[40,60,80,80]},
  "hourly":{"time":["2026-08-30T10:00"],"cape":[300.0],"wind_gusts_10m":[20.0]}}]
JSON
    ;;
  *geocoding-api.open-meteo.com*)
    echo '{"results":[{"name":"Reykjavik","latitude":64.1466,"longitude":-21.9426,"country":"Iceland"}]}'
    ;;
  *rainviewer.com*)
    echo '{"host":"https://tilecache.rainviewer.com","radar":{"past":[{"time":1788000000,"path":"/v2/radar/x"}]}}'
    ;;
  *) exit 22 ;;
esac
FAKE

chmod +x "$work/bin/omarchy-weather-location" "$work/bin/curl"

# `qs -p` treats the config file's directory as the root and refuses to load
# anything above it, so the probe cannot sit in test/ and reach ../Service.qml.
# The real files are staged beside it instead of being reimplemented.
cp "$plugin/Service.qml" "$work/plugin/"
cp -r "$plugin/lib" "$work/plugin/"
mkdir -p "$work/plugin/data" && cp "$plugin/data/basemap.bin" "$work/plugin/data/" 2>/dev/null

cat > "$work/plugin/probe.qml" <<'PROBE'
import QtQuick
import Quickshell
import Quickshell.Io

ShellRoot {
  id: harness

  property int step: 0

  function report(key, value) { console.log("PROBE " + key + "=" + value) }

  Loader {
    id: serviceLoader
    source: Qt.resolvedUrl("Service.qml")
    onStatusChanged: {
      if (status === Loader.Error) harness.report("loaded", "error")
      if (status === Loader.Ready && item) {
        item.settings = {
          alertsEnabled: true, alertRadiusKm: 100, alertMinIntensity: "Light",
          colorScheme: "TITAN", defaultZoom: 7, smoothTiles: true,
          showSnow: true, showLabel: false
        }
      }
    }
  }

  Process {
    id: setProc
    command: ["omarchy-weather-location", "--set", "Reykjavik", "64.1466,-21.9426"]
  }

  Timer {
    interval: 1200
    repeat: true
    running: true
    onTriggered: {
      harness.step++
      var s = serviceLoader.item
      var n = harness.step

      if (n === 1) {
        harness.report("loaded", s ? "yes" : "no")
        if (!s) { Qt.quit(); return }
        harness.report("empty.state", s.locationState)
        harness.report("empty.hasLocation", s.hasLocation)
        harness.report("empty.reading", s.lastCheckTime > 0 ? "yes" : "no")
      } else if (n === 2) {
        setProc.running = true
      } else if (n === 3) {
        // Written, but only the watch could have noticed — and it cannot.
        harness.report("beforeReload.state", s.locationState)
      } else if (n === 4) {
        s.reloadLocation()
      } else if (n === 5) {
        harness.report("afterReload.state", s.locationState)
        harness.report("afterReload.name", s.locationName)
      } else if (n === 7) {
        harness.report("check.reading", s.lastCheckTime > 0 ? "yes" : "no")
        harness.report("check.outlook", s.outlookLabel)
        // A flag cleared only from onExited is how this plugin froze twice.
        harness.report("check.settled", s.checking ? "still-checking" : "settled")
        Qt.quit()
      }
    }
  }
}
PROBE

out=$(env HOME="$home" PATH="$work/bin:$PATH" \
      QT_QPA_PLATFORM=offscreen XDG_RUNTIME_DIR="$work/runtime" \
      timeout 60 qs -p "$work/plugin/probe.qml" 2>&1 | sed -n 's/.*PROBE //p')

value() { printf '%s\n' "$out" | sed -n "s/^$1=//p" | tail -1; }

if [[ $(value loaded) != "yes" ]]; then
  echo "  FAIL  Service.qml did not load under Quickshell" >&2
  printf '%s\n' "$out" >&2
  exit 1
fi
check "Service.qml loads under a real QML engine" "yes" "$(value loaded)"

check "an empty home reads as unset, not as a location"      "unset" "$(value empty.state)"
check "and claims no location"                               "false" "$(value empty.hasLocation)"
check "and asserts no reading"                               "no"    "$(value empty.reading)"

# The gap: the settings directory did not exist when the watch was set up, so
# the first file ever written into it is invisible until somebody says so.
check "the first write is invisible to the file watch"       "unset" "$(value beforeReload.state)"

check "reloadLocation() closes that gap"                     "ready"      "$(value afterReload.state)"
check "and the name arrives with it"                         "Reykjavik"  "$(value afterReload.name)"

check "a first location produces a reading"                  "yes"     "$(value check.reading)"
check "and an outlook from it"                               "Light"   "$(value check.outlook)"
check "and the in-flight flag clears"                        "settled" "$(value check.settled)"

echo
if [[ $failures -eq 0 ]]; then
  echo "first run: all checks passed"
else
  echo "first run: $failures failed"
fi
[[ $failures -eq 0 ]]
