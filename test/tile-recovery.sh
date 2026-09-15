#!/usr/bin/env bash
#
# The radar recovering on its own, run in the real `Service.qml` under
# Quickshell.
#
# The ways it could get stuck and stay stuck until someone restarted the
# shell, with RainViewer switched between working, no network, hanging and a
# full disk while the probe runs:
#  - a batch whose tiles cannot be fetched at all leaves them failed and
#    retried, not quietly dropped with the map loading them for ever;
#  - a batch that hangs, and a request for the frame list that hangs, are
#    stopped, while a long run of slow but healthy batches is not;
#  - a failed request for the frame list is asked again a minute later;
#  - a check of the frame list that a sleeping machine missed is made anyway;
#  - when the network comes back, whether a list request failed meanwhile or
#    not, the tiles that failed while it was gone come back at once rather
#    than after the backoff they built up;
#  - a disk with no room turns the cache off, and tiles come from the network.

source "$(dirname "$0")/harness.sh"
require qs python3

# A list whose newest frame is twenty minutes old, so that the service always
# has reason to ask for it again, and every request is a real one.
now=$(date +%s)
newest=$(( now - now % 600 - 1200 ))
manifest_json $(( newest - 12 * 600 )) "$newest" > "$work/plugin/current-manifest.json"

fake_rainviewer
stage_service

cat > "$work/plugin/probe.qml" <<'PROBE'
import QtQuick
import Quickshell
import "lib/TileCache.js" as TileCache

ShellRoot {
  id: harness

  property var s: serviceLoader.item
  property var jobs: []
  property int phase: 0
  property real phaseStarted: 0
  property string listStarted: ""

  Kit { id: kit; service: harness.s }

  Loader {
    id: serviceLoader
    source: Qt.resolvedUrl("Service.qml")
    onStatusChanged: {
      if (status === Loader.Error) { kit.report("loaded", "error"); Qt.quit() }
      if (status === Loader.Ready && item) {
        item.settings = { alertsEnabled: false, colorScheme: "TITAN", defaultZoom: 7 }
        // Short enough to happen inside the probe; the heartbeat checks them
        // every five seconds, and two beats are more than this.
        item.manifestTimeoutMs = 9000
        item.tileBatchTimeoutMs = 9000
        item.acquireManifest()
        harness.next()
      }
    }
  }

  function next() { phase++; phaseStarted = Date.now() }
  // The newest frame's tiles for a small view: a single batch, whatever the
  // batch size, which is what the steps below each need.
  function newestJobs(lat, lon) { return kit.viewJobs(lat, lon, s.frames.length - 1, 1, 300, 256) }
  function countCalls() { kit.shell("grep -c '^manifest' '" + kit.path("calls.log") + "' || true") }

  Timer {
    interval: 20
    repeat: true
    running: true
    onTriggered: {
      if (!s || !kit.shellDone) return
      var waited = Date.now() - harness.phaseStarted

      if (phase === 1) {
        if (s.frames.length !== 13 || s.manifestPending || s.tileCacheState !== "ready") return
        // The newest frame in hand is overdue, so the next look is a minute on.
        kit.report("after-first-list-in-s", Math.round((s.nextManifestCheckAt - Date.now()) / 1000))
        // A batch that cannot be fetched at all: its URLs are not ones curl
        // may be handed.
        var time = s.frames[s.frames.length - 1].time
        jobs = [{ key: TileCache.tileKey(time, 7, 1, 1, 2, true, false),
                  url: "https://tilecache.rainviewer.com/v2/radar/[0-9]/x.png" },
                { key: TileCache.tileKey(time, 7, 2, 1, 2, true, false),
                  url: "file:///etc/passwd" }]
        s.wantTiles("probe", jobs)
        next()
      } else if (phase === 2) {
        if (waited < 500) return
        var dropped = 0
        for (var i = 0; i < jobs.length; i++) {
          var k = jobs[i].key
          if (!s.tileRetries[k] && !s.tilesInFlight[k] && !s.tilesOnDisk[k]) dropped++
        }
        kit.report("unfetchable-dropped", dropped)
        kit.setMode("slow")
        next()
      } else if (phase === 3) {
        // Eight slow batches back to back, a second and a half each: twelve
        // seconds of fetching, more than the nine a single batch may run,
        // none of it one batch running long.
        jobs = kit.viewJobs(52.5, 13.4, 0, 8)
        s.wantTiles("probe", jobs)
        next()
      } else if (phase === 4) {
        if (!kit.allOnDisk(jobs) && waited < 30000) return
        kit.report("slow-on-disk", kit.onDisk(jobs))
        kit.report("slow-took-ms", waited)
        kit.setMode("hang")
        next()
      } else if (phase === 5) {
        // A batch that hangs: stopped at the first beat past its timeout.
        s.tileBatchTimeoutMs = 2000
        jobs = newestJobs(35.7, 139.7)
        s.wantTiles("probe", jobs)
        next()
      } else if (phase === 6) {
        // Read the moment it is stopped, and the fake taken off "hang" at once,
        // before the retry of those tiles comes due five seconds later.
        var stopped = kit.retried(jobs).split("/")
        if (stopped[0] !== stopped[1] && waited < 12000) return
        s.tileBatchTimeoutMs = 90000
        kit.report("hung-in-flight", Object.keys(s.tilesInFlight).length)
        kit.report("hung-retried", kit.retried(jobs))
        // The network goes away, and a request for the list fails.
        kit.setMode("down")
        next()
      } else if (phase === 7) {
        s.lastManifestFetchMs = 0
        s.refreshManifest()
        next()
      } else if (phase === 8) {
        if (s.manifestPending || waited < 300) return
        kit.report("failed-list-failures", s.frameFailures)
        kit.report("after-failed-list-in-s", Math.round((s.nextManifestCheckAt - Date.now()) / 1000))
        // The tiles have failed for long enough that their backoff has grown.
        for (var j = 0; j < jobs.length; j++) {
          s.tileRetries[jobs[j].key] = { at: Date.now() + 300000, attempts: 5, status: 503 }
        }
        kit.setMode("ok")
        next()
      } else if (phase === 9) {
        // The network is back, and the machine slept through the check of the
        // list: the heartbeat makes it, and the list answering after failures
        // is what brings the tiles back.
        s.lastManifestFetchMs = 0
        s.nextManifestCheckAt = Date.now() - 5000
        countCalls()
        next()
      } else if (phase === 10) {
        kit.report("list-calls-before", kit.shellAnswer)
        next()
      } else if (phase === 11) {
        if (!kit.allOnDisk(jobs) && waited < 12000) return
        kit.report("back-with-list", kit.onDisk(jobs))
        kit.report("back-with-list-ms", waited)
        countCalls()
        next()
      } else if (phase === 12) {
        kit.report("list-calls-after", kit.shellAnswer)
        kit.report("failures-after", s.frameFailures)
        // A short outage while the list is current: no list request fails.
        jobs = newestJobs(41.9, 12.5)
        kit.setMode("down")
        next()
      } else if (phase === 13) {
        s.wantTiles("probe", jobs)
        next()
      } else if (phase === 14) {
        if (waited < 1000) return
        kit.report("outage-failed", kit.retried(jobs))
        // The outage has lasted long enough for their delays to grow. The
        // records are the service's own, so they say what it recorded about
        // the batch they failed in.
        for (var m = 0; m < jobs.length; m++) {
          var record = s.tileRetries[jobs[m].key]
          if (!record) continue
          record.at = Date.now() + 25000
          record.attempts = 4
        }
        kit.setMode("ok")
        next()
      } else if (phase === 15) {
        // Something else on screen is fetched and arrives, and that is the
        // network working.
        s.wantTiles("probe", jobs.concat(newestJobs(-23.5, -46.6)))
        next()
      } else if (phase === 16) {
        if (!kit.allOnDisk(jobs) && waited < 10000) return
        kit.report("back-with-tile", kit.onDisk(jobs))
        kit.report("back-with-tile-ms", waited)
        kit.setMode("hanglist")
        next()
      } else if (phase === 17) {
        // A request for the frame list that never ends.
        s.manifestTimeoutMs = 2000
        s.lastManifestFetchMs = 0
        s.refreshManifest()
        next()
      } else if (phase === 18) {
        // A process reads as running once it has started, a moment later.
        if (listStarted === "" && waited >= 500) listStarted = s.manifestPending ? "yes" : "no"
        if (waited < 9000) return
        kit.report("list-started", listStarted)
        kit.report("list-stuck", s.manifestPending ? "yes" : "no")
        kit.setMode("full")
        next()
      } else if (phase === 19) {
        // A disk with no room left.
        s.wantTiles("probe", newestJobs(-33.9, 151.2))
        next()
      } else if (phase === 20) {
        if (s.tileCacheState !== "off" && waited < 5000) return
        kit.report("full-disk-state", s.tileCacheState)
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

run_qs 140 HOME="$home"
require_done

in_range() { [[ $1 =~ ^-?[0-9]+$ && $1 -ge $2 && $1 -le $3 ]] && echo yes || echo "no ($1)"; }
check "an overdue frame list is asked for again in a minute" "yes" "$(in_range "$(value after-first-list-in-s)" 58 61)"
check "a batch that cannot be fetched leaves its tiles failed, not dropped" "0" "$(value unfetchable-dropped)"
check "a long run of slow but healthy batches all arrives" "yes" "$(all_of "$(value slow-on-disk)")"
check "and outlasts the time one batch may take, so that means something" \
  "yes" "$([[ $(value slow-took-ms) -gt 9000 ]] && echo yes || echo "no ($(value slow-took-ms) ms)")"
check "and none of them was stopped as hung" \
  "0" "$(sed -n '/PROBE slow-took-ms/q;p' <<< "$out" | grep -c 'a tile batch ran for')"
check "a batch that hangs is stopped, and holds nothing in flight" "0" "$(value hung-in-flight)"
check "and its tiles are failures, to be retried" "yes" "$(all_of "$(value hung-retried)")"
check "the heartbeat said it stopped the batch" \
  "yes" "$(printf '%s\n' "$out" | grep -q 'a tile batch ran for' && echo yes || echo no)"
check "a request for the list that fails is counted" "1" "$(value failed-list-failures)"
check "and asked again a minute later" "yes" "$(in_range "$(value after-failed-list-in-s)" 58 61)"
check "a check of the list the machine slept through is made anyway" \
  "1" "$(( $(value list-calls-after) - $(value list-calls-before) ))"
check "the network back, failed tiles come back with the list" "yes" "$(all_of "$(value back-with-list)")"
check "at once, not after the backoff they had built up" \
  "yes" "$([[ $(value back-with-list-ms) -lt 8000 ]] && echo yes || echo no)"
check "and the list is no longer failing" "0" "$(value failures-after)"
check "a short outage fails the tiles asked for during it" "yes" "$(all_of "$(value outage-failed)")"
check "and they come back with the next tile that arrives" "yes" "$(all_of "$(value back-with-tile)")"
check "within seconds" "yes" "$([[ $(value back-with-tile-ms) -lt 8000 ]] && echo yes || echo no)"
check "a request for the frame list that never ends was under way" "yes" "$(value list-started)"
check "and is stopped" "no" "$(value list-stuck)"
check "a full disk gives the cache up and falls back to the network" "off" "$(value full-disk-state)"

finish "tile recovery"
