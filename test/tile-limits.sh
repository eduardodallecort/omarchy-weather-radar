#!/usr/bin/env bash
#
# The tile cache's limits, run in the real `Service.qml` under Quickshell.
#
#  - A tile's file deleted from under the map is no longer offered as on disk,
#    and reopening the map fetches it once more.
#  - A tile that keeps arriving unreadable is fetched again after a growing
#    delay, which other tiles arriving does not cut short, and after a few
#    times is left alone until the map is opened again: the frame list coming
#    back after failing does not give it another go either.
#  - Past its ceiling on tiles, the cache starts over with what is on screen,
#    rather than growing for as long as someone explores.
#  - Starting over while a frame's directory is being deleted waits for that
#    delete, rather than letting it finish into the refilled cache. `rm` is
#    made slow for the whole run so that the two overlap every time.
#  - A frame dropped from the list while a batch is still writing its tiles is
#    deleted once that batch ends, not under it, where curl would fail to
#    write and give the whole cache up.

source "$(dirname "$0")/harness.sh"
require qs python3

now=$(date +%s)
first=$(( now - now % 600 - 12 * 600 ))
manifest_json "$first" $(( first + 12 * 600 )) > "$work/plugin/current-manifest.json"
manifest_json $(( first + 600 )) $(( first + 13 * 600 )) > "$work/plugin/manifest-next.json"
manifest_json $(( first + 1200 )) $(( first + 14 * 600 )) > "$work/plugin/manifest-next2.json"

fake_rainviewer
fake rm <<'FAKE'
#!/usr/bin/env bash
sleep 1
exec /usr/bin/rm "$@"
FAKE
stage_service

cat > "$work/plugin/probe.qml" <<'PROBE'
import QtQuick
import Quickshell

ShellRoot {
  id: harness

  property var s: serviceLoader.item
  property var jobs: []
  property var jobsF: []
  property var jobsR: []
  property var waits: []
  property var jobsD: []
  property real dropped: 0
  property int phase: 0
  property real phaseStarted: 0

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
  function file(job) { return s.tileCacheDir + "/" + job.key }

  // The tile arriving whole, as applyTileReport records it, and the map
  // finding it cannot load it.
  function arriveUnreadable(job) {
    delete s.tileRetries[job.key]
    s.tilesOnDisk[job.key] = true
    s.tilesOnDiskCount++
    s.tileUnreadable("file://" + file(job))
    var retry = s.tileRetries[job.key]
    waits.push(retry.gaveUp ? "gave-up" : Math.round((retry.at - Date.now()) / 1000))
  }

  function readFile(name) {
    var xhr = new XMLHttpRequest()
    xhr.open("GET", Qt.resolvedUrl(name), false)
    xhr.send()
    return xhr.responseText
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
        jobs = kit.viewJobs(52.5, 13.4, 0)
        s.wantTiles("probe", jobs)
        next()
      } else if (phase === 2) {
        if (!kit.allOnDisk(jobs) && waited < 30000) return
        // A tile's file disappears under the running map, and the map finds
        // it cannot load it.
        kit.report("deleted-url", jobs[0].url)
        kit.shell("rm -f '" + file(jobs[0]) + "'")
        next()
      } else if (phase === 3) {
        s.tileUnreadable("file://" + file(jobs[0]))
        kit.report("deleted-state", s.tileState(jobs[0].key))
        kit.reopen("probe")
        s.wantTiles("probe", jobs)
        next()
      } else if (phase === 4) {
        if (!kit.allOnDisk([jobs[0]]) && waited < 10000) return
        kit.shell("test -s '" + file(jobs[0]) + "' && echo back || echo missing")
        next()
      } else if (phase === 5) {
        kit.report("deleted-refetched", kit.shellAnswer)
        kit.report("bad-url", jobs[1].url)
        // The same tile arriving unreadable again and again, as a body Qt
        // cannot decode would. Once, and then other tiles arrive: the network
        // working is not a reason to fetch it before its delay is up.
        arriveUnreadable(jobs[1])
        kit.markLog("unreadable-once")
        next()
      } else if (phase === 6) {
        jobsR = kit.viewJobs(41.9, 12.5, 0, 2)
        s.wantTiles("probe", jobs.concat(jobsR))
        next()
      } else if (phase === 7) {
        if (!kit.allOnDisk(jobsR) && waited < 10000) return
        kit.markLog("unreadable-more")
        next()
      } else if (phase === 8) {
        arriveUnreadable(jobs[1])
        arriveUnreadable(jobs[1])
        kit.report("unreadable-waits", waits.join(","))
        s.wantTiles("probe", jobs)
        var queued = s.tileQueue.some(function(job) { return job.key === jobs[1].key })
        kit.report("unreadable-left-alone", s.tileState(jobs[1].key) + (queued ? ",queued" : ",not-queued"))
        // The frame list answering after failing is the network coming back,
        // which says nothing about a tile that arrived and could not be read.
        s.frameFailures = 1
        s.applyManifestResponse(0, readFile("current-manifest.json"))
        var requeued = s.tileQueue.some(function(job) { return job.key === jobs[1].key })
        kit.report("unreadable-after-list", s.tileState(jobs[1].key) + (requeued ? ",queued" : ",not-queued"))
        kit.markLog("reopen-given-up")
        next()
      } else if (phase === 9) {
        // Opening the map again is the one thing that gives it another go.
        kit.reopen("probe")
        s.wantTiles("probe", jobs)
        next()
      } else if (phase === 10) {
        if (!kit.allOnDisk([jobs[1]]) && waited < 10000) return
        kit.report("given-up-back", kit.onDisk([jobs[1]]))
        // And its count starts again: unreadable once more, it waits the first
        // delay rather than being given up at once.
        waits = []
        arriveUnreadable(jobs[1])
        kit.report("after-reopen-wait", waits[0])
        // The ceiling: the next arrival goes past it.
        s.maxTilesOnDisk = s.tilesOnDiskCount
        jobsF = kit.viewJobs(35.7, 139.7, 0, 2)
        s.wantTiles("probe", jobsF)
        next()
      } else if (phase === 11) {
        if (!kit.allOnDisk(jobsF) && waited < 20000) return
        kit.report("after-ceiling", kit.onDisk(jobsF))
        kit.countFiles(s.tileCacheDir)
        next()
      } else if (phase === 12) {
        kit.report("files-after-ceiling", kit.shellAnswer)
        kit.report("wanted-after-ceiling", jobsF.length)
        // A frame leaves, its directory starts being deleted, and the cache
        // starts over before that delete has finished.
        s.maxTilesOnDisk = 2000
        s.applyManifestResponse(0, readFile("manifest-next.json"))
        s.startTileCacheOver()
        jobsF = kit.viewJobs(35.7, 139.7, 0, 2)
        s.wantTiles("probe", jobsF)
        next()
      } else if (phase === 13) {
        if ((!kit.allOnDisk(jobsF) || waited < 4000) && waited < 20000) return
        kit.report("after-overlap", kit.onDisk(jobsF))
        var paths = []
        for (var key in s.tilesOnDisk) paths.push("'" + s.tileCacheDir + "/" + key + "'")
        kit.report("offered-after-overlap", paths.length)
        kit.shell("n=0; for f in " + paths.join(" ") + "; do [ -f \"$f\" ] || n=$((n + 1)); done; echo $n")
        next()
      } else if (phase === 14) {
        kit.report("offered-but-missing", kit.shellAnswer)
        // A batch still writing the oldest frame's tiles when a new list drops
        // that frame. The batch is slowed so that the two overlap.
        kit.setMode("slow")
        next()
      } else if (phase === 15) {
        dropped = s.frames[0].time
        jobsD = kit.viewJobs(-33.9, 151.2, 0, 1)
        s.wantTiles("probe", jobsD)
        next()
      } else if (phase === 16) {
        if (Object.keys(s.tilesInFlight).length === 0 && waited < 5000) return
        kit.report("dropped-was-writing", Object.keys(s.tilesInFlight).length > 0 ? "yes" : "no")
        s.applyManifestResponse(0, readFile("manifest-next2.json"))
        kit.report("dropped-delete", s.framesToDelete.indexOf(dropped) >= 0 ? "waits" : "started")
        // As the panel does, the map stops wanting the frame that left.
        s.wantTiles("probe", [])
        next()
      } else if (phase === 17) {
        if ((Object.keys(s.tilesInFlight).length > 0 || s.framesToDelete.length > 0 || waited < 3000)
            && waited < 15000) return
        kit.report("dropped-cache", s.tileCacheState)
        kit.shell("test -e '" + s.tileCacheDir + "/" + dropped + "' && echo present || echo gone")
        next()
      } else if (phase === 18) {
        kit.report("dropped-after", kit.shellAnswer)
        kit.report("done", "yes")
        Qt.quit()
      }
    }
  }

  Timer {
    interval: 100000
    running: true
    onTriggered: { kit.report("timeout", "phase " + harness.phase); Qt.quit() }
  }
}
PROBE

run_qs 120 HOME="$home" QML_XHR_ALLOW_FILE_READ=1
require_done

log=$work/plugin/requests.log

check "a file gone from under the map is no longer offered, and is coming again" \
  "coming" "$(value deleted-state)"
check "and reopening the map fetches it again" "back" "$(value deleted-refetched)"
check "exactly once more" "2" "$(grep -cxF "$(value deleted-url)" "$log")"
check "an unreadable tile waits longer each time, then is left alone" "5,15,gave-up" "$(value unreadable-waits)"
check "and other tiles arriving does not cut its delay short" "0" \
  "$(grep -cxF "$(value bad-url)" <<< "$(sed -n '/^unreadable-once$/,/^unreadable-more$/p' "$log")")"
check "the arriving tiles did arrive" "1" "$(grep -cx unreadable-more "$log")"
check "and is neither waited for nor fetched again" "failed,not-queued" "$(value unreadable-left-alone)"
check "not even when the frame list comes back after failing" "failed,not-queued" "$(value unreadable-after-list)"
check "until the map is opened again" "yes" "$(all_of "$(value given-up-back)")"
check "which starts its count again" "5" "$(value after-reopen-wait)"
check "past the ceiling on tiles the cache starts over with what is on screen" \
  "yes" "$(all_of "$(value after-ceiling)")"
check "and holds only that on disk" "$(value wanted-after-ceiling)" "$(value files-after-ceiling)"
check "starting over while a frame is being deleted refills the cache" "yes" "$(all_of "$(value after-overlap)")"
check "and every tile it offers is really on disk" "0" "$(value offered-but-missing)"
check "which is not nothing" "yes" "$([[ $(value offered-after-overlap) -gt 0 ]] && echo yes || echo no)"
check "a batch was writing the frame the new list dropped" "yes" "$(value dropped-was-writing)"
check "and its delete waits for that batch" "waits" "$(value dropped-delete)"
check "then happens, with the cache still working" "gone,ready" "$(value dropped-after),$(value dropped-cache)"

finish "tile limits"
