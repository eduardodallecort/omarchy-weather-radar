#!/usr/bin/env bash
#
# What a forecast response is an answer to.
#
# A check takes as long as curl takes — up to twelve seconds — and both halves
# of the question it asks can move while it is out. The user picks a different
# city, or widens the alert radius, and the handlers that react to that call
# checkNow(), which refuses to start a second request while one is in flight.
# So the change is left with nothing running for it, and the response that
# eventually lands answers the question nobody is asking any more.
#
# Unchecked, the visible result is a notification built from one city's forecast
# and another city's name: the body ends with `locationName`, read at the moment
# the toast is built rather than at the moment the request went out.
#
# This runs the real Service.qml under Quickshell with a curl that takes two
# seconds to answer and reports a different severity per city, changes the
# location while the first request is in flight, and reads what came out — both
# the outlook the service holds and the toast it actually sent.
#
# Offline by construction: curl, omarchy-weather-location and
# omarchy-notification-send are all replaced on PATH. Skips without `qs`;
# RADAR_REQUIRE_QS makes that skip fatal, which is what CI sets.

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

cat > "$work/bin/omarchy-weather-location" <<'FAKE'
#!/usr/bin/env bash
file=$HOME/.local/state/omarchy/settings/weather.json
mkdir -p "$(dirname "$file")"
printf '{"name":"%s","latitude":%s,"longitude":%s}\n' "$2" "${3%,*}" "${3#*,}" > "$file"
FAKE

# Every toast the service sends, one line each, so the body can be read back.
cat > "$work/bin/omarchy-notification-send" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$HOME/notifications.log"
FAKE

# Slow on purpose, and different per city. Reykjavik answers with drizzle,
# Detroit with a downpour, so which response was applied is legible in the
# outlook rather than having to be inferred.
cat > "$work/bin/curl" <<'FAKE'
#!/usr/bin/env bash
url=""
for arg in "$@"; do case "$arg" in https://*) url=$arg ;; esac; done
case "$url" in
  *api.open-meteo.com/v1/forecast*)
    sleep 2
    rate=0.1
    case "$url" in *latitude=42*) rate=2.0 ;; esac
    cat <<JSON
[{"latitude":0,"longitude":0,"timezone":"UTC",
  "minutely_15":{"time":["2026-08-30T10:00","2026-08-30T10:15","2026-08-30T10:30","2026-08-30T10:45"],
                 "precipitation":[$rate,$rate,$rate,$rate],"precipitation_probability":[80,80,80,80]},
  "hourly":{"time":["2026-08-30T10:00"],"cape":[0.0],"wind_gusts_10m":[5.0]}}]
JSON
    ;;
  *) exit 22 ;;
esac
FAKE

chmod +x "$work/bin/omarchy-weather-location" "$work/bin/omarchy-notification-send" "$work/bin/curl"

cp "$plugin/Service.qml" "$work/plugin/"
cp -r "$plugin/lib" "$work/plugin/"

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

  Process { id: setReykjavik; command: ["omarchy-weather-location", "--set", "Reykjavik", "64.1466,-21.9426"] }
  Process { id: setDetroit;   command: ["omarchy-weather-location", "--set", "Detroit", "42.3314,-83.0458"] }

  // 600 ms, so the location change lands inside curl's two-second answer.
  Timer {
    interval: 600
    repeat: true
    running: true
    onTriggered: {
      harness.step++
      var s = serviceLoader.item
      var n = harness.step
      if (!s) { harness.report("loaded", "no"); Qt.quit(); return }

      if (n === 1) {
        harness.report("loaded", "yes")
        setReykjavik.running = true
      } else if (n === 2) {
        s.reloadLocation()
      } else if (n === 3) {
        // The request for Reykjavik is out and will not answer for another
        // second and a half.
        harness.report("inflight", s.checking ? "yes" : "no")
        setDetroit.running = true
      } else if (n === 4) {
        s.reloadLocation()
        harness.report("moved.name", s.locationName)
      } else if (n === 14) {
        harness.report("final.name", s.locationName)
        harness.report("final.outlook", s.outlookLabel)
        harness.report("final.settled", s.checking ? "still-checking" : "settled")
        Qt.quit()
      }
    }
  }
}
PROBE

out=$(env HOME="$home" PATH="$work/bin:$PATH" \
      QT_QPA_PLATFORM=offscreen XDG_RUNTIME_DIR="$work/runtime" \
      QT_LOGGING_RULES="*=true" \
      timeout 90 qs -p "$work/plugin/probe.qml" 2>&1 | sed -n 's/.*PROBE //p')

value() { printf '%s\n' "$out" | sed -n "s/^$1=//p" | tail -1; }

if [[ $(value loaded) != "yes" ]]; then
  echo "  FAIL  Service.qml did not load under Quickshell" >&2
  printf '%s\n' "$out" >&2
  exit 1
fi

log=$home/notifications.log
[[ -f $log ]] || : > "$log"

check "a check is still in flight when the city changes" "yes" "$(value inflight)"
check "the new city is the one the service holds"        "Detroit" "$(value moved.name)"

# Reykjavik's response arrives after the move. Applying it would report drizzle
# — and say it about Detroit.
check "the outlook is the new city's, not the one in flight" "Heavy" "$(value final.outlook)"
check "and the service is not left checking"                 "settled" "$(value final.settled)"

# The toast is where the mismatch would be visible to a person.
count=$(grep -c . "$log")
check "one toast, not one per response" "1" "$count"

if grep -q "Light rain" "$log"; then
  printf '  FAIL  a toast reported the city in flight\n'
  cat "$log"
  failures=$((failures + 1))
else
  printf '  ok    no toast reports the severity of the discarded response\n'
fi

if grep -q "Detroit" "$log" && grep -q "Heavy rain" "$log"; then
  printf '  ok    the toast names the city whose forecast it carries\n'
else
  printf '  FAIL  the toast does not pair Detroit with its own forecast\n'
  cat "$log"
  failures=$((failures + 1))
fi

echo
if [[ $failures -eq 0 ]]; then
  echo "stale forecast: all checks passed"
else
  echo "stale forecast: $failures failed"
fi
[[ $failures -eq 0 ]]
