#!/usr/bin/env bash
#
# The lightning watch, end to end.
#
# Runs the real Service.qml under Quickshell with lightning alerts on and the
# map closed, a fake feed (python3 on PATH) that reports strikes around home,
# and omarchy-notification-send replaced by a log. Checks that the feed runs
# without the map, that a strike inside the radius notifies with its distance
# and direction, that the storm's next strikes stay quiet, that one clearly
# closer breaks the quiet, and that strikes outside the radius or long past
# are ignored. Skips without `qs`.

source "$(dirname "$0")/harness.sh"
require qs

fake omarchy-weather-location <<'FAKE'
#!/usr/bin/env bash
exit 0
FAKE

fake omarchy-notification-send <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$HOME/notifications.log"
FAKE

# Home is Detroit, 42.3314,-83.0458. Offsets are in miles north and east.
fake python3 <<'FAKE'
#!/usr/bin/env bash
echo started >> "$HOME/feed.log"
exec /usr/bin/python3 - <<'PY'
import math, sys, time
LAT, LON = 42.3314, -83.0458
def strike(north, east, age_s=0):
    lat = LAT + north * 1.609344 / 111.195
    lon = LON + east * 1.609344 / (111.195 * math.cos(math.radians(LAT)))
    ms = int((time.time() - age_s) * 1000)
    print(f"{lat:.4f} {lon:.4f} {ms}", flush=True)
time.sleep(2)
strike(14.1, -14.1)        # 20 mi NW: notifies
time.sleep(0.5)
strike(0, 30)              # 30 mi E, same storm: quiet
time.sleep(0.5)
strike(0, 80)              # 80 mi E: outside 50 mi
strike(-5, 0, age_s=600)   # ten minutes old: history
time.sleep(0.5)
strike(-5, 0)              # 5 mi S: clearly closer, notifies
time.sleep(60)
PY
FAKE

stage_service
mkdir -p "$home/.local/state/omarchy/settings"
printf '{"name":"Detroit","latitude":42.3314,"longitude":-83.0458}\n' \
  > "$home/.local/state/omarchy/settings/weather.json"

cat > "$work/plugin/probe.qml" <<'PROBE'
import QtQuick
import Quickshell

ShellRoot {
  id: harness
  function report(key, value) { console.log("PROBE " + key + "=" + value) }

  Loader {
    id: serviceLoader
    source: Qt.resolvedUrl("Service.qml")
    onStatusChanged: {
      if (status === Loader.Error) harness.report("loaded", "error")
      if (status === Loader.Ready && item) {
        item.settings = {
          alertsEnabled: false, alertRadiusKm: 100, alertMinIntensity: "Heavy",
          colorScheme: "TITAN", defaultZoom: 7, smoothTiles: true,
          showSnow: true, showLabel: false, showLightning: true,
          lightningAlertsEnabled: true, lightningAlertRadiusMiles: 50
        }
      }
    }
  }

  Timer {
    interval: 7000
    running: true
    onTriggered: {
      var s = serviceLoader.item
      harness.report("loaded", s ? "yes" : "no")
      if (s) {
        harness.report("count", s.nearbyStrikeCount)
        harness.report("status", s.lightningStatus)
        s.settings = Object.assign({}, s.settings, { lightningAlertsEnabled: false })
      }
      stop.start()
    }
  }
  Timer {
    id: stop
    interval: 1000
    onTriggered: {
      harness.report("feedRunning", serviceLoader.item.lightningFeedWanted ? "yes" : "no")
      Qt.quit()
    }
  }
}
PROBE

run_qs 60 HOME="$home"

if [[ $(value loaded) != "yes" ]]; then
  echo "  FAIL  Service.qml did not load under Quickshell" >&2
  printf '%s\n' "$out" >&2
  exit 1
fi

log=$home/notifications.log
[[ -f $log ]] || : > "$log"

check "the feed runs with the map closed"          "1" "$(grep -c started "$home/feed.log" 2> /dev/null || echo 0)"
check "two notifications: the first, then closer"  "2" "$(wc -l < "$log" | tr -d ' ')"
check "the first gives distance and direction"     "yes" "$(sed -n 1p "$log" | grep -q 'Lightning 20 miles NW Strike 20 miles northwest of Detroit' && echo yes || echo no)"
check "the closer one is 5 miles south"            "yes" "$(sed -n 2p "$log" | grep -q 'Lightning 5 miles S Strike 5 miles south of Detroit' && echo yes || echo no)"
check "a close strike is urgent"                   "yes" "$(sed -n 2p "$log" | grep -q -- '-u critical' && echo yes || echo no)"
check "strikes outside or stale are not counted"   "3" "$(value count)"
check "the panel line names the latest strike"     "yes" "$(value status | grep -q '^3 strikes · latest 5 miles S at' && echo yes || echo no)"
check "turning alerts off stops the feed"          "no" "$(value feedRunning)"

finish "lightning alert"
