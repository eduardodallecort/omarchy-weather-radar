#!/usr/bin/env bash
#
# The service on machines that do not look like the one it was written on.
#
# A plugin is installed by strangers, and their homes are not this one: a state
# file that cannot be written, no home at all in a session started some
# unusual way. None of that may stop the service, or make it write anywhere
# else. What cannot be kept on disk is kept in memory, and the journal says so
# once. With no home there is no location either, so no alert to send. (A disk
# with no room for the tile cache is test/tile-recovery.sh.)
#
# Two runs of the real `Service.qml` under Quickshell, offline, with `curl`,
# `omarchy-weather-location` and `omarchy-notification-send` replaced on PATH:
#
#  1. The alert record cannot be written: its directory is read-only, and a
#     directory stands where the file would go, which stops root as well (CI
#     runs as root). The forecast is wet enough to alert: the alert must still
#     be sent, the failed write of its record said once, and nothing written.
#     The map is never opened, so nothing may ask for radar frames either.
#  2. No HOME at all. The service must load, keep its alert record in memory
#     rather than wait for a file it has no path for, run without a tile cache,
#     and create nothing relative to wherever it was started.
#
# Needs `qs`; skips without it, and RADAR_REQUIRE_QS turns the skip into a
# failure, which is what CI sets.

source "$(dirname "$0")/harness.sh"
require qs

mkdir -p "$work/elsewhere"

# A forecast wet enough for any threshold, and a notification sender that
# only writes down that it was asked.
fake curl <<'FAKE'
#!/usr/bin/env bash
url=""
for arg in "$@"; do case "$arg" in https://*) url=$arg ;; esac; done
case "$url" in
  *api.open-meteo.com/v1/forecast*)
    cat <<'JSON'
[{"latitude":64.15,"longitude":-21.94,"timezone":"Atlantic/Reykjavik",
  "minutely_15":{"time":["2026-08-30T10:00","2026-08-30T10:15","2026-08-30T10:30","2026-08-30T10:45"],
                 "precipitation":[3.0,4.0,4.0,4.0],"precipitation_probability":[90,90,90,90]},
  "hourly":{"time":["2026-08-30T10:00"],"cape":[300.0],"wind_gusts_10m":[20.0]}}]
JSON
    ;;
  *rainviewer*) echo "$url" >> "$HOME/rainviewer.log"; exit 22 ;;
  *) exit 22 ;;
esac
FAKE
fake omarchy-notification-send <<FAKE
#!/usr/bin/env bash
echo sent >> "$work/notifications.log"
FAKE
fake omarchy-weather-location <<'FAKE'
#!/usr/bin/env bash
exit 0
FAKE

stage_service

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
      if (status === Loader.Error) { harness.report("loaded", "error"); Qt.quit() }
      if (status === Loader.Ready && item) {
        item.settings = {
          alertsEnabled: true, alertRadiusKm: 100, alertMinIntensity: "Light",
          colorScheme: "TITAN", defaultZoom: 7, smoothTiles: true,
          showSnow: true, showLabel: false
        }
        harness.report("loaded", "yes")
      }
    }
  }

  // A write of the alert record, whatever the weather, so that where it goes
  // is tested even on a machine with no location.
  Timer {
    interval: 2000
    running: true
    onTriggered: if (serviceLoader.item) serviceLoader.item.storeLatch(2)
  }

  // Done once the record has been dealt with, one way or the other, after the
  // write above; at most fifteen seconds.
  property real started: Date.now()
  Timer {
    interval: 100
    repeat: true
    running: true
    onTriggered: {
      var s = serviceLoader.item
      var waited = Date.now() - harness.started
      var settled = s && s.latchLoaded && waited > 2500
        && (s.latchPath === "" || (s.latchWriteFailed && s.notifiedLevel > 0))
      if (!settled && waited < 15000) return
      harness.report("latch-path", s.latchPath === "" ? "none" : "set")
      harness.report("latch-loaded", s.latchLoaded ? "yes" : "no")
      harness.report("latch-write-failed", s.latchWriteFailed ? "yes" : "no")
      harness.report("notified-level", s.notifiedLevel)
      harness.report("cache", s.tileCacheState)
      harness.report("done", "yes")
      Qt.quit()
    }
  }
}
PROBE

# Each run starts from a directory of its own, so anything written relative
# to where the shell started would show up there.
run() { # label, then env arguments
  local label=$1; shift
  : > "$work/notifications.log"
  run_dir=$work/elsewhere run_qs 60 "$@"
  printf '%s\n' "$out" > "$work/$label.out"
  require_done
}

# ------------------------------------------------ a state directory that is read-only

mkdir -p "$home/.local/state/omarchy/settings"
printf '{"name":"Reykjavik","latitude":64.1466,"longitude":-21.9426}\n' \
  > "$home/.local/state/omarchy/settings/weather.json"
mkdir "$home/.local/state/omarchy/weather-radar-alert.json"
chmod 555 "$home/.local/state/omarchy"
run readonly HOME="$home"

echo "a read-only state directory"
check "the service loads" "yes" "$(value loaded)"
check "the storm alert is still sent" "yes" "$([[ -s $work/notifications.log ]] && echo yes || echo no)"
check "and remembered for the session" "yes" "$([[ $(value notified-level) -gt 0 ]] && echo yes || echo no)"
check "the failed write of its record is noticed" "yes" "$(value latch-write-failed)"
check "and said once in the journal" "1" "$(grep -c 'cannot write .*weather-radar-alert.json' "$work/readonly.out")"
check "and nothing was written" "no" \
  "$([[ -f $home/.local/state/omarchy/weather-radar-alert.json ]] && echo yes || echo no)"
check "a map never opened asks for no radar frames" "0" \
  "$([[ -f $home/rainviewer.log ]] && wc -l < "$home/rainviewer.log" || echo 0)"

# ------------------------------------------------ no home at all

run nohome -u HOME

echo
echo "no HOME"
check "the service loads" "yes" "$(value loaded)"
check "the alert record has no file" "none" "$(value latch-path)"
check "and is read as empty rather than waited for" "yes" "$(value latch-loaded)"
check "the radar runs without a tile cache" "off" "$(value cache)"
check "and nothing is created where the shell was started" "" "$(ls -A "$work/elsewhere")"

finish "restricted environments"
