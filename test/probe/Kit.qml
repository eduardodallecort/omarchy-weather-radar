import QtQuick
import Quickshell
import Quickshell.Io
import "lib/TileCache.js" as TileCache

// What the service probes in test/ need beside their own steps: report a
// finding, run a shell command and read its answer, switch the fake
// RainViewer, and ask the service which tiles are on disk. Staged beside the
// probe by harness.sh, so its paths resolve to the probe's own directory.
Item {
  id: kit

  property var service: null

  function report(key, value) { console.log("PROBE " + key + "=" + value) }

  // A file beside the probe, as a path for the shell.
  function path(name) { return Qt.resolvedUrl(name).toString().replace("file://", "") }

  // One command at a time. A probe's steps wait on `shellDone` before going
  // on, and read the command's output from `shellAnswer`.
  property bool shellDone: true
  property string shellAnswer: ""

  function shell(script) {
    shellDone = false
    shellProc.command = ["sh", "-c", script]
    shellProc.running = true
  }

  Process {
    id: shellProc
    stdout: StdioCollector { id: shellOut; waitForEnd: true }
    onExited: {
      kit.shellAnswer = shellOut.text.trim()
      kit.shellDone = true
    }
  }

  function countFiles(dir) { shell("find '" + dir + "' -name '*.png' -type f | wc -l") }
  function setMode(mode) { shell("echo " + mode + " > '" + path("mode") + "'") }
  function markLog(line) { shell("echo " + line + " >> '" + path("requests.log") + "' && echo marked") }

  // The whole loop, or `count` frames of it from `start`, for a view at zoom 7
  // centred on a place: 900x600 unless another size is given.
  function viewJobs(lat, lon, start, count, width, height) {
    return TileCache.loopJobs(service.tileHost, service.frames, start,
      TileCache.viewTiles(lat, lon, 7, width || 900, height || 600), 7, 2, true, false, count)
  }

  // "n/total": how many of these tiles the service offers as files on disk.
  function onDisk(jobs) {
    var n = 0
    for (var i = 0; i < jobs.length; i++) {
      var source = service.tileSource(jobs[i].key)
      if (typeof source === "string" && source.indexOf("file://") === 0) n++
    }
    return n + "/" + jobs.length
  }

  function allOnDisk(jobs) {
    var parts = onDisk(jobs).split("/")
    return parts[0] === parts[1]
  }

  // "n/total": how many of these tiles are failures waiting to be retried.
  function retried(jobs) {
    var n = 0
    for (var i = 0; i < jobs.length; i++) if (service.tileRetries[jobs[i].key]) n++
    return n + "/" + jobs.length
  }

  // Closing the map and opening it again, the way the panel does.
  function reopen(owner) {
    service.releaseManifest(owner)
    service.acquireManifest()
  }
}
