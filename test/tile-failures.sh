#!/usr/bin/env bash
#
# When radar tiles fail, run in the real `Service.qml` under Quickshell.
#
# The newest frame's tiles fail in the two ways that matter: RainViewer's 429
# in even tile columns, and a timeout that never reached a server in odd ones.
# From that:
#  - a 429 pauses all fetching, is named on the map, and its tiles are not
#    waited for or asked for again while the backoff lasts, even across closing
#    and reopening the map;
#  - a timeout that has happened once is still coming: waited for, said as
#    loading, and retried; reopening the map retries it at once, once the rate
#    limit has passed;
#  - a timeout that happens again is a failure, and the map says so plainly;
#  - a frame on disk says nothing, whatever the others are doing;
#  - the service wakes for a retry when it is due, not on its next heartbeat;
#  - failures no map wants any more do not wake it at all;
#  - a second 429 backs off harder than the first;
#  - a tile that times out in a batch where the others arrive keeps its own
#    delay, rather than being fetched again in every batch beside them.
#
# The view is small enough that the newest frame is a single batch whatever
# the batch size, since a 429 holds back every batch after the one it answered.

source "$(dirname "$0")/harness.sh"
require qs python3

now=$(date +%s)
first=$(( now - now % 600 - 12 * 600 ))
newest=$(( first + 12 * 600 ))
manifest_json "$first" "$newest" > "$work/plugin/current-manifest.json"

fake_rainviewer
echo "/v2/radar/$newest/ parity" > "$work/plugin/rules"
stage_service

cat > "$work/plugin/probe.qml" <<'PROBE'
import QtQuick
import Quickshell
import "lib/TileCache.js" as TileCache

ShellRoot {
  id: harness

  property var s: serviceLoader.item
  property var jobs: []
  property var jobsE: []
  property var jobsM: []
  property string mixedColumn: ""
  property int phase: 0
  property real phaseStarted: 0
  property int revisionAtRest: 0

  Kit { id: kit; service: harness.s }

  Loader {
    id: serviceLoader
    source: Qt.resolvedUrl("Service.qml")
    onStatusChanged: {
      if (status === Loader.Error) { kit.report("loaded", "error"); Qt.quit() }
      if (status === Loader.Ready && item) {
        item.settings = { alertsEnabled: false, colorScheme: "TITAN", defaultZoom: 7 }
        item.acquireManifest()
        harness.next()
      }
    }
  }

  function next() { phase++; phaseStarted = Date.now() }
  function small(start, count) { return kit.viewJobs(52.5, 13.4, start, count, 300, 256) }

  // The state of each of the newest frame's tiles, by column parity, and what
  // the map would say about a set of tiles.
  function newest() { return s.frames[s.frames.length - 1].time }
  function newestJobs(even) {
    return jobs.filter(function(j) {
      return TileCache.frameOfKey(j.key) === newest() && (Number(j.key.split("/")[2]) % 2 === 0) === even
    })
  }
  function states(list) { return list.map(function(j) { return s.tileState(j.key) }) }
  function distinct(list) { return list.filter(function(x, i, a) { return a.indexOf(x) === i }).join(",") }
  function sources(list, wanted) {
    return list.filter(function(j) { return s.tileSource(j.key) === wanted }).length + "/" + list.length
  }

  Timer {
    interval: 20
    repeat: true
    running: true
    onTriggered: {
      if (!s || !kit.shellDone) return
      var waited = Date.now() - harness.phaseStarted

      if (phase === 1) {
        if (s.frames.length !== 13 || s.manifestPending) return
        // Every frame but the newest first, so that it is asked for alone.
        jobs = small(0, 12)
        s.wantTiles("probe", jobs)
        next()
      } else if (phase === 2) {
        if (!kit.allOnDisk(jobs) && waited < 20000) return
        jobs = small(0)
        kit.report("newest-fits-a-batch", newestJobs(true).length + newestJobs(false).length <= TileCache.BATCH_SIZE ? "yes" : "no")
        s.wantTiles("probe", jobs)
        next()
      } else if (phase === 3) {
        // The newest frame has failed once, every tile of it.
        var failedOnce = newestJobs(true).concat(newestJobs(false))
        if (kit.retried(failedOnce).split("/")[0] !== String(failedOnce.length) && waited < 10000) return
        var even = newestJobs(true), odd = newestJobs(false)
        kit.report("wake-in-ms", Math.round(s.tileWakeAt - Date.now()))
        kit.report("refused", even.length)
        kit.report("timed-out", odd.length)
        kit.report("refused-state", distinct(states(even)))
        kit.report("timed-out-state", distinct(states(odd)))
        kit.report("refused-not-waited-for", sources(even, ""))
        kit.report("timed-out-waited-for", sources(odd, null))
        kit.report("paused", s.tilesPausedUntil > Date.now() ? "yes" : "no")
        kit.report("notice-newest", TileCache.radarNotice(states(even.concat(odd))))
        kit.report("notice-timed-out", TileCache.radarNotice(states(odd)))
        var older = jobs.filter(function(j) { return TileCache.frameOfKey(j.key) === s.frames[0].time })
        kit.report("notice-on-disk", TileCache.radarNotice(states(older)) || "none")
        kit.markLog("reopened-paused")
        next()
      } else if (phase === 4) {
        // Closed and reopened while the rate limit still holds: nothing may be
        // fetched, the tiles that only timed out included.
        kit.reopen("probe")
        s.wantTiles("probe", jobs)
        next()
      } else if (phase === 5) {
        if (waited < 1500) return
        kit.markLog("reopened-after")
        next()
      } else if (phase === 6) {
        // The pause runs out, and the map is reopened: the timeouts are asked
        // for at once, while the refused tiles wait out their own backoff. The
        // timeouts' own retry is put a minute off first, so that only the
        // reopening can bring them back in this window.
        for (var r in s.tileRetries) {
          if (s.tileRetries[r].status !== 429) s.tileRetries[r].at = Date.now() + 60000
        }
        s.tilesPausedUntil = 0
        kit.reopen("probe")
        s.wantTiles("probe", jobs)
        next()
      } else if (phase === 7) {
        if (waited < 1500) return
        kit.markLog("second-try")
        next()
      } else if (phase === 8) {
        // Their retry comes due, and they time out again.
        for (var key in s.tileRetries) {
          if (s.tileRetries[key].status !== 429) s.tileRetries[key].at = Date.now() - 1
        }
        s.rebuildTileQueue()
        next()
      } else if (phase === 9) {
        if (waited < 1500) return
        var repeated = newestJobs(false)
        kit.report("repeated-state", distinct(states(repeated)))
        kit.report("notice-repeated", TileCache.radarNotice(states(repeated)))
        // The map moves on to frames and places that are not failing.
        jobsE = kit.viewJobs(48.9, 2.35, 0, 2)
        s.wantTiles("probe", jobsE)
        next()
      } else if (phase === 10) {
        if (!kit.allOnDisk(jobsE) && waited < 10000) return
        // What failed before is due now, and no map wants it.
        var due = 0
        for (var k in s.tileRetries) {
          if (s.wantedKeys[k]) continue
          s.tileRetries[k].at = Date.now() - 1
          due++
        }
        kit.report("unwanted-due", due)
        revisionAtRest = s.tileRevision
        next()
      } else if (phase === 11) {
        if (waited < 6000) return
        kit.report("revisions-at-rest", s.tileRevision - revisionAtRest)
        kit.markLog("escalation")
        next()
      } else if (phase === 12) {
        // The refused tiles come due, the pause with them, and RainViewer
        // refuses twice running, with nothing arriving in between.
        for (var r2 in s.tileRetries) s.tileRetries[r2].at = Date.now() - 1
        s.tilesPausedUntil = 0
        s.wantTiles("probe", jobs)
        next()
      } else if (phase === 13) {
        if (s.tilesPausedUntil === 0 && waited < 10000) return
        kit.report("first-pause-s", Math.round((s.tilesPausedUntil - Date.now()) / 1000))
        for (var r3 in s.tileRetries) s.tileRetries[r3].at = Date.now() - 1
        s.tilesPausedUntil = 0
        s.rebuildTileQueue()
        next()
      } else if (phase === 14) {
        if (s.tilesPausedUntil === 0 && waited < 10000) return
        kit.report("second-pause-s", Math.round((s.tilesPausedUntil - Date.now()) / 1000))
        // One column of a place not seen yet times out, in every frame, while
        // the rest of each batch arrives beside it.
        s.tilesPausedUntil = 0
        jobsM = kit.viewJobs(40.4, -3.7, 0, 3)
        mixedColumn = jobsM[0].key.split("/")[2]
        kit.shell("echo '/256/7/" + mixedColumn + "/ timeout' > '" + kit.path("rules") + "'"
          + " && echo mixed >> '" + kit.path("requests.log") + "'")
        next()
      } else if (phase === 15) {
        s.wantTiles("probe", jobsM)
        next()
      } else if (phase === 16) {
        var timingOut = jobsM.filter(function(j) { return j.key.split("/")[2] === mixedColumn })
        var arriving = jobsM.filter(function(j) { return j.key.split("/")[2] !== mixedColumn })
        if (!kit.allOnDisk(arriving) && waited < 10000) return
        kit.report("mixed-column", mixedColumn)
        kit.report("mixed-timing-out", timingOut.length)
        kit.report("mixed-arrived", kit.onDisk(arriving))
        kit.report("mixed-kept", kit.retried(timingOut))
        kit.report("mixed-state", distinct(states(timingOut)))
        kit.markLog("mixed-end")
        next()
      } else if (phase === 17) {
        kit.report("done", "yes")
        Qt.quit()
      }
    }
  }

  Timer {
    interval: 60000
    running: true
    onTriggered: { kit.report("timeout", "phase " + harness.phase); Qt.quit() }
  }
}
PROBE

run_qs 90 HOME="$home"
require_done

log=$work/plugin/requests.log
refused=$(value refused)
timed_out=$(value timed-out)
newest_requests() { grep "/v2/radar/$newest/" | awk -F/ -v parity="$1" '$(NF-3) % 2 == parity'; }

check "there are refused tiles and timed-out tiles to judge" \
  "yes" "$([[ $refused -gt 0 && $timed_out -gt 0 ]] && echo yes || echo no)"
check "and the newest frame fits one batch" "yes" "$(value newest-fits-a-batch)"
check "a 429 reads as a rate limit" "limited" "$(value refused-state)"
check "and pauses the fetching" "yes" "$(value paused)"
check "and its tiles are not waited for" "yes" "$(all_of "$(value refused-not-waited-for)")"
check "the map names the rate limit over a frame it cannot draw" \
  "Radar paused: RainViewer is limiting requests" "$(value notice-newest)"
check "a timeout that has happened once is still coming" "coming" "$(value timed-out-state)"
check "and waited for, since it will likely come" "yes" "$(all_of "$(value timed-out-waited-for)")"
check "and said as loading, not as a failure" "Loading radar…" "$(value notice-timed-out)"
check "a timeout that happens again is a failure" "failed" "$(value repeated-state)"
check "and the map says so plainly" "Couldn't load the radar" "$(value notice-repeated)"
check "a frame on disk says nothing" "none" "$(value notice-on-disk)"

check "reopening during a rate limit asks for nothing" "0" "$(urls_between "$log" reopened-paused reopened-after)"
check "once it has passed, reopening retries the timeouts at once" \
  "$timed_out" "$(sed -n '/^reopened-after$/,/^second-try$/p' "$log" | newest_requests 1 | sort -u | wc -l)"
check "but not what RainViewer refused, whose backoff still holds" \
  "$refused" "$(sed '/^escalation$/,$d' "$log" | newest_requests 0 | wc -l)"

wake=$(value wake-in-ms)
check "the service wakes when the first retry is due, not on its heartbeat" \
  "yes" "$([[ $wake -gt 1000 && $wake -le 5100 ]] && echo yes || echo "no ($wake ms)")"
check "failures no map wants are due, so the next check means something" \
  "yes" "$([[ $(value unwanted-due) -gt 0 ]] && echo yes || echo no)"
check "and the service does nothing about them" "0" "$(value revisions-at-rest)"
first_pause=$(value first-pause-s)
pause=$(value second-pause-s)
check "a 429 pauses for about a minute" \
  "yes" "$([[ $first_pause -gt 50 && $first_pause -le 60 ]] && echo yes || echo "no (${first_pause} s)")"
check "and a second one running, for about two" \
  "yes" "$([[ $pause -gt 100 && $pause -le 120 ]] && echo yes || echo "no (${pause} s)")"

check "a column that times out beside tiles that arrive leaves them to arrive" \
  "yes" "$(all_of "$(value mixed-arrived)")"
check "and keeps its own delay, rather than being revived by them" \
  "yes" "$(all_of "$(value mixed-kept)")"
check "so it is still coming after one failure, not failing for ever unseen" "coming" "$(value mixed-state)"
check "and is fetched once, not again in every batch beside it" "$(value mixed-timing-out)" \
  "$(sed -n '/^mixed$/,/^mixed-end$/p' "$log" | grep -c "/256/7/$(value mixed-column)/")"

finish "tile failures"
