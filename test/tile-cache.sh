#!/usr/bin/env bash
#
# Each radar tile fetched once, run in the real `Service.qml` under Quickshell.
#
# The cache exists so that each tile of the loop is fetched once instead of on
# every pass, which is what RainViewer's rate limit was answering. That claim
# is about requests, so it is counted: RainViewer is replaced by a fake that
# logs every URL. The service is given a whole loop to fetch, then asked for it
# again, and the log must show each tile once.
#
# Also what the cache promises about its directory and its schedule:
#  - a cache left by an earlier session is cleared before anything is written;
#  - two maps asking at once both get their loop;
#  - a frame that leaves the loop takes its tiles with it, and an older list
#    does not replace the one in hand;
#  - the next look at the frame list is timed from the newest frame;
#  - a map closed mid-loop stops fetching, and looks at the frame list no more.
#
# Failures are test/tile-failures.sh, the cache's limits test/tile-limits.sh,
# and recovering from what could leave it stuck test/tile-recovery.sh.

source "$(dirname "$0")/harness.sh"
require qs python3

cache=$home/.cache/omarchy/plugins/eduardodallecort.weather-radar/tiles

# Thirteen frames ten minutes apart, as RainViewer publishes them; the same
# list a frame later, the oldest gone; and one from twenty minutes before.
now=$(date +%s)
first=$(( now - now % 600 - 12 * 600 ))
manifest_json "$first" $(( first + 12 * 600 )) > "$work/plugin/current-manifest.json"
manifest_json $(( first + 600 )) $(( first + 13 * 600 )) > "$work/plugin/manifest-next.json"
manifest_json $(( first - 2400 )) $(( first + 9 * 600 )) > "$work/plugin/manifest-older.json"

fake_rainviewer
stage_service

# Left by an earlier session: nothing the service did not write itself is
# trusted, so this must be gone once the map has opened.
mkdir -p "$cache/1000000000/7/1/1"
echo "stale" > "$cache/1000000000/7/1/1/2_1_0.png"

cat > "$work/plugin/probe.qml" <<'PROBE'
import QtQuick
import Quickshell
import "lib/RadarModel.js" as RadarModel
import "lib/TileCache.js" as TileCache

ShellRoot {
  id: harness

  property var s: serviceLoader.item
  property var jobs: []
  property var jobsC: []
  property var jobsD: []
  property var jobsT: []
  property int phase: 0
  property real phaseStarted: 0
  property real lastTick: 0
  property real longestGap: 0

  Kit { id: kit; service: harness.s }

  Loader {
    id: serviceLoader
    source: Qt.resolvedUrl("Service.qml")
    onStatusChanged: {
      if (status === Loader.Error) { kit.report("loaded", "error"); Qt.quit() }
      if (status === Loader.Ready && item) {
        item.settings = { alertsEnabled: false, colorScheme: "TITAN", defaultZoom: 7 }
        // What the panel does on opening, without the basemap it also asks for.
        item.acquireManifest()
        harness.next()
      }
    }
  }

  function readFile(name) {
    var xhr = new XMLHttpRequest()
    xhr.open("GET", Qt.resolvedUrl(name), false)
    xhr.send()
    return xhr.responseText
  }

  function next() { phase++; phaseStarted = Date.now() }

  Timer {
    interval: 16
    repeat: true
    running: true
    onTriggered: {
      var now = Date.now()
      if (harness.lastTick > 0) harness.longestGap = Math.max(harness.longestGap, now - harness.lastTick)
      harness.lastTick = now
      if (!s || !kit.shellDone) return
      var waited = now - harness.phaseStarted

      if (phase === 1) {
        if (s.frames.length !== 13 || s.manifestPending) return
        var expected = RadarModel.nextManifestCheckMs(s.latestFrameTime, now)
        kit.report("check-timed-from-frame",
          Math.abs(s.nextManifestCheckAt - now - expected) < 2000 ? "yes" : (s.nextManifestCheckAt - now) + " vs " + expected)
        jobs = kit.viewJobs(52.5, 13.4, 0)
        kit.report("jobs", jobs.length)
        s.wantTiles("probe", jobs)
        next()
      } else if (phase === 2) {
        if (!kit.allOnDisk(jobs) && waited < 30000) return
        kit.report("cache-state", s.tileCacheState)
        kit.report("on-disk", kit.onDisk(jobs))
        kit.countFiles(s.tileCacheDir)
        next()
      } else if (phase === 3) {
        kit.report("files", kit.shellAnswer)
        kit.markLog("second-request")
        next()
      } else if (phase === 4) {
        // The same loop asked for again, from another frame.
        s.wantTiles("probe", kit.viewJobs(52.5, 13.4, 5))
        next()
      } else if (phase === 5) {
        if (waited < 1000) return
        // Two maps at once, on two monitors, looking at two other places.
        jobsC = kit.viewJobs(41.9, 12.5, 0)
        jobsD = kit.viewJobs(-23.5, -46.6, 0)
        kit.markLog("two-maps")
        next()
      } else if (phase === 6) {
        s.acquireManifest()
        s.wantTiles("probe", jobsC)
        s.wantTiles("second", jobsD)
        next()
      } else if (phase === 7) {
        if (!(kit.allOnDisk(jobsC) && kit.allOnDisk(jobsD)) && waited < 30000) return
        kit.report("map-one", kit.onDisk(jobsC))
        kit.report("map-two", kit.onDisk(jobsD))
        s.releaseManifest("second")
        // Ten minutes later: the oldest frame leaves, a newer one arrives, and
        // RainViewer says so too from here on.
        kit.shell("test -d '" + s.tileCacheDir + "/" + s.frames[0].time + "' && echo there; cp '"
          + kit.path("manifest-next.json") + "' '" + kit.path("current-manifest.json")
          + "' && echo new-list >> '" + kit.path("requests.log") + "'")
        next()
      } else if (phase === 8) {
        kit.report("oldest-dir-before", kit.shellAnswer)
        s.applyManifestResponse(0, readFile("manifest-next.json"))
        next()
      } else if (phase === 9) {
        if (waited < 500) return
        var oldest = jobs[0].key
        kit.report("evicted-source", s.tileSource(oldest) === null ? "null" : String(s.tileSource(oldest)))
        jobs = kit.viewJobs(52.5, 13.4, 0)
        s.wantTiles("probe", jobs)
        next()
      } else if (phase === 10) {
        if (!kit.allOnDisk(jobs) && waited < 30000) return
        kit.report("after-new-list", kit.onDisk(jobs))
        // A list older than the one in hand, a cache somewhere answering with
        // one it kept, does not take the newest frame away.
        var newest = s.latestFrameTime
        s.applyManifestResponse(0, readFile("manifest-older.json"))
        kit.report("older-list-ignored", s.latestFrameTime === newest ? "yes" : "no")
        // A whole loop somewhere new, and the map closed as it starts coming.
        jobsT = kit.viewJobs(35.7, 139.7, 0)
        s.wantTiles("probe", jobsT)
        next()
      } else if (phase === 11) {
        if (kit.onDisk(jobsT).split("/")[0] === "0" && waited < 10000) return
        s.releaseManifest("probe")
        kit.report("check-when-closed", s.nextManifestCheckAt)
        kit.report("batch-size", TileCache.BATCH_SIZE)
        kit.markLog("closed")
        next()
      } else if (phase === 12) {
        if (waited < 2000) return
        kit.report("longest-gap-ms", Math.round(longestGap))
        kit.report("done", "yes")
        Qt.quit()
      }
    }
  }

  Timer {
    interval: 110000
    running: true
    onTriggered: { kit.report("timeout", "phase " + harness.phase); Qt.quit() }
  }
}
PROBE

run_qs 150 HOME="$home" QML_XHR_ALLOW_FILE_READ=1
require_done

jobs=$(value jobs)
per_frame=$(( jobs / 13 ))
newest=$(( first + 13 * 600 ))
log=$work/plugin/requests.log
tiles=$(grep -v '^[a-z-]*$' "$log")

check "the cache is ready once the map opens" "ready" "$(value cache-state)"
check "the next look at the frame list is timed from the newest frame" "yes" "$(value check-timed-from-frame)"
check "a whole loop is offered as on disk" "yes" "$(all_of "$(value on-disk)")"
check "and is on disk, as files" "$jobs" "$(value files)"
check "the earlier session's cache is cleared before anything is written" \
  "gone" "$([[ -e $cache/1000000000 ]] && echo present || echo gone)"

check "no tile is fetched twice, however often the loop is asked for" \
  "$(printf '%s\n' "$tiles" | sort -u | wc -l)" "$(printf '%s\n' "$tiles" | wc -l)"
check "asking for the same loop again fetches nothing" "0" "$(urls_between "$log" second-request two-maps)"
check "two maps asking at once both get their whole loop" "yes" "$(all_of "$(value map-one)")"
check "and the second map too" "yes" "$(all_of "$(value map-two)")"

check "the oldest frame's tiles were on disk before it left" "there" "$(value oldest-dir-before)"
check "a frame that leaves the loop leaves the disk" \
  "gone" "$([[ -e $cache/$first ]] && echo present || echo gone)"
check "and is no longer offered as on disk" "null" "$(value evicted-source)"
check "and is not asked for again once it has left" \
  "0" "$(grep -c "/v2/radar/$first/" <<< "$(sed -n '/^new-list$/,$p' "$log")")"
check "the log was marked when the list moved on" "1" "$(grep -cx new-list "$log")"
check "a newly listed frame is fetched" "yes" "$(all_of "$(value after-new-list)")"
check "and only its own tiles are" \
  "$per_frame" "$(grep -c "/v2/radar/$newest/256/7/[0-9]*/[0-9]*/2/" "$log")"
check "an older frame list does not replace the one in hand" "yes" "$(value older-list-ignored)"
check "a closed map does not look at the frame list at all" "0" "$(value check-when-closed)"
closed=$(urls_between "$log" closed)
check "a map closed mid-loop fetches at most the batch already under way" \
  "yes" "$([[ $closed =~ ^[0-9]+$ && $closed -le $(value batch-size) ]] && echo yes || echo "no ($closed)")"

# Forty-odd processes start in this run, and a shared runner is slower and
# noisier than a laptop, so the bound is far looser than basemap-steps.sh's.
# What it catches is the thread being held by work done in QML, which is
# seconds when it happens, not a slow fork.
gap=$(value longest-gap-ms)
check "fetching never stalls the shell for 400 ms (longest ${gap} ms)" \
  "yes" "$([[ $gap -lt 400 ]] && echo yes || echo no)"

echo
printf '%s tiles per loop, %s requests in all\n' "$jobs" "$(printf '%s\n' "$tiles" | wc -l)"
finish "tile cache"
