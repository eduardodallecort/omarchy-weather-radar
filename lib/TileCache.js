// Radar tiles kept on disk for as long as their frame is in the loop.
//
// Qt keeps only about 4 MB of images that nothing is drawing, roughly
// seventeen radar tiles, while a loop is thirteen frames of six to twenty
// tiles. Left to Qt, every pass through the loop would fetch every tile again,
// and RainViewer answers that sustained rate with 429. Holding the decoded
// images instead would cost 256 KB a tile, about 65 MB for a loop, inside the
// process that owns the bar and the lock screen. The PNGs as served are under
// 10 KB each, so the loop is kept as files and decoded from disk as it plays.
//
// Tiles are fetched by curl straight into the cache, so their bytes never pass
// through the shell until an Image decodes one at the size it asked for. Every
// name on disk is built here from numbers, never from anything a server sent,
// and every command that writes or deletes is built here too, where the checks
// on those names live.

.pragma library

.import "TileMath.js" as TileMath
.import "RadarModel.js" as RadarModel

// Measured against the real endpoint on 2026-09-12: 334 bytes for a tile of
// clear sky, about 8 KB for one full of rain. A 256 px palette image cannot
// need much more than 64 KB even uncompressed, so this is a wide margin that
// still bounds what one tile can put on disk.
var TILE_MAX_BYTES = 131072

// How many tiles the cache holds before it starts over. A loop for one view is
// a couple of hundred; this is a morning of looking around, and at the byte
// ceiling above it bounds the directory at a few hundred megabytes whatever a
// server sends. Past it, the cache is emptied and refilled with what the maps
// on screen want.
var MAX_TILES_ON_DISK = 2000
var TILE_TIMEOUT_SEC = 15

// One process per batch, a few transfers at once inside it. A batch is about
// one frame of a panel-sized view, so a loop is a dozen processes rather than
// two hundred.
var BATCH_SIZE = 16
var PARALLEL_TRANSFERS = 4

// The directory the cache lives in must end here. Anything this module deletes
// is inside it, so the check below is what stands between a bad value and
// `rm -rf` on somewhere else.
var CACHE_SUFFIX = "/omarchy/plugins/eduardodallecort.weather-radar/tiles"

function isWhole(value, min, max) {
  return typeof value === "number" && isFinite(value) && Math.floor(value) === value
    && value >= min && value <= max
}

function isCacheDir(dir) {
  if (typeof dir !== "string" || dir.charAt(0) !== "/") return false
  if (dir.length > 512 || dir.length <= CACHE_SUFFIX.length) return false
  if (dir.slice(-CACHE_SUFFIX.length) !== CACHE_SUFFIX) return false
  // Control characters, and the three that would end or escape the path in
  // the file:// URL the tiles are loaded from.
  if (/[\x00-\x1f#%?]/.test(dir)) return false
  return dir.split("/").indexOf("..") === -1
}

// Where the cache lives: XDG's cache directory when it is set to something
// absolute, the conventional one under home otherwise.
function cacheDir(home, xdgCacheHome) {
  var base = typeof xdgCacheHome === "string" && xdgCacheHome.charAt(0) === "/"
    ? xdgCacheHome.replace(/\/+$/, "")
    : (typeof home === "string" && home.charAt(0) === "/" ? home.replace(/\/+$/, "") + "/.cache" : "")
  if (base === "") return ""
  var dir = base + CACHE_SUFFIX
  return isCacheDir(dir) ? dir : ""
}

// The name a tile is stored under, relative to the cache directory:
//   <frame time>/<zoom>/<x>/<y>/<scheme>_<smooth>_<snow>.png
// The frame's publication time names its directory, so a frame that leaves
// the loop is one directory to delete. "" for anything out of range, so no
// caller can turn a value that did not pass through here into a path.
function tileKey(frameTime, zoom, x, y, colorScheme, smooth, snow) {
  if (!isWhole(frameTime, 1, 99999999999)) return ""
  if (!isWhole(zoom, 0, 20)) return ""
  var edge = Math.pow(2, zoom) - 1
  if (!isWhole(x, 0, edge) || !isWhole(y, 0, edge)) return ""
  if (!isWhole(colorScheme, 0, 255)) return ""
  return frameTime + "/" + zoom + "/" + x + "/" + y + "/"
    + colorScheme + "_" + (smooth ? 1 : 0) + "_" + (snow ? 1 : 0) + ".png"
}

var KEY_PATTERN = /^(\d{1,11})\/\d{1,2}\/\d{1,7}\/\d{1,7}\/\d{1,3}_[01]_[01]\.png$/

function isTileKey(key) {
  return typeof key === "string" && KEY_PATTERN.test(key)
}

function frameOfKey(key) {
  var match = isTileKey(key) ? KEY_PATTERN.exec(key) : null
  return match ? Number(match[1]) : 0
}

// ---------------------------------------------------------------------------
// What to fetch
// ---------------------------------------------------------------------------

// The tiles a view needs, as whole tile coordinates. The same range TileLayer
// lays out, without the screen positions.
function viewTiles(lat, lon, zoom, width, height) {
  var view = TileMath.viewportTiles(lat, lon, zoom, Math.max(1, width), Math.max(1, height))
  var list = []
  for (var y = view.minY; y <= view.maxY; y++) {
    if (!TileMath.isValidTileY(y, zoom)) continue
    for (var x = view.minX; x <= view.maxX; x++) {
      var wrapped = TileMath.wrapTileX(x, zoom)
      var seen = false
      for (var i = 0; i < list.length; i++) {
        if (list[i].x === wrapped && list[i].y === y) { seen = true; break }
      }
      if (!seen) list.push({ x: wrapped, y: y })
    }
  }
  return list
}

// Every tile of the loop's frames for one view, as { key, url } jobs, in the
// order the loop will want them: the frame on screen first, then the ones
// after it, wrapping round. Fetching in that order means playback meets tiles
// that have already arrived rather than ones still queued behind the rest of
// the loop. `frameCount` stops after that many frames; the whole loop without
// it.
function loopJobs(host, frames, startIndex, tiles, zoom, colorScheme, smooth, snow, frameCount) {
  var jobs = []
  if (!RadarModel.isTileHost(host) || !frames || frames.length === 0) return jobs
  var start = isWhole(startIndex, 0, frames.length - 1) ? startIndex : 0
  var count = isWhole(frameCount, 0, frames.length) ? frameCount : frames.length
  for (var step = 0; step < count; step++) {
    var frame = frames[(start + step) % frames.length]
    // Checked when the manifest was parsed, and again here: a path without its
    // leading slash would join the host's name and send the request elsewhere.
    if (!frame || !RadarModel.isFramePath(frame.path)) continue
    for (var i = 0; i < tiles.length; i++) {
      var key = tileKey(frame.time, zoom, tiles[i].x, tiles[i].y, colorScheme, smooth, snow)
      if (key === "") continue
      var url = RadarModel.tileUrl(host, frame.path, 256, zoom, tiles[i].x, tiles[i].y,
        colorScheme, smooth, snow)
      if (url !== "") jobs.push({ key: key, url: url })
    }
  }
  return jobs
}

// Several lists of jobs as one queue: the first of each, then the second of
// each, and so on, with any tile asked for twice kept at its first place. Two
// maps open on two monitors each get their tiles at the same pace, instead of
// whichever asked last starving the other.
function interleave(lists) {
  var merged = []
  var seen = {}
  var longest = 0
  for (var i = 0; i < (lists || []).length; i++) longest = Math.max(longest, lists[i].length)
  for (var n = 0; n < longest; n++) {
    for (var j = 0; j < lists.length; j++) {
      var job = lists[j][n]
      if (!job || seen[job.key]) continue
      seen[job.key] = true
      merged.push(job)
    }
  }
  return merged
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

// A tile URL as RainViewer's are built: an https origin, then path segments of
// letters, digits, dots, underscores and hyphens, none of them starting with
// a dot. The host and the frame path in it come from the manifest, and each
// was checked when it was parsed; this checks the result again at the point
// it is handed to a process.
var TILE_URL_PATTERN = /^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)+\.png$/

function isTileUrl(url) {
  return typeof url === "string" && url.length <= 512 && TILE_URL_PATTERN.test(url)
}

// One curl for a batch of tiles, each written to its place in the cache.
// `-f` turns an HTTP error into a failed transfer instead of an error page
// saved as a tile, and `--remove-on-error` deletes whatever a failed or
// oversized transfer had written, so a file on disk is always a whole
// response. `--globoff` stops curl from reading brackets or braces in a URL
// as a list of URLs to fetch, which is how one job could become millions of
// transfers, each adding a line to the report below.
//
// With that, the report curl prints is one line per job, in this format and
// with these paths, so its size is set here rather than by the server: at
// most a batch of lines of a few hundred bytes each.
function fetchCommand(dir, jobs) {
  if (!isCacheDir(dir) || !jobs || jobs.length === 0) return []
  var command = ["curl", "-fs", "--globoff", "--proto", "=https",
                 "--max-time", String(TILE_TIMEOUT_SEC),
                 "--max-filesize", String(TILE_MAX_BYTES),
                 "--parallel", "--parallel-max", String(PARALLEL_TRANSFERS),
                 "--create-dirs", "--remove-on-error",
                 "-w", "%{exitcode} %{http_code} %{filename_effective}\\n"]
  var transfers = 0
  for (var i = 0; i < jobs.length && transfers < BATCH_SIZE; i++) {
    if (!isTileKey(jobs[i].key) || !isTileUrl(jobs[i].url)) continue
    command.push(jobs[i].url, "-o", dir + "/" + jobs[i].key)
    transfers++
  }
  return transfers > 0 ? command : []
}

// What curl reported, as the keys that arrived and the ones that did not.
// A job missing from the report counts as failed: the process was killed, or
// never ran, and nothing it may have left behind is trusted. `written` lists
// every key curl reported as transferred whatever the status, because a
// response that is not a 200 but not an error either, a redirect, leaves its
// body on disk: its frame's directory is then known, and goes with the frame.
function parseFetchReport(text, dir, jobs) {
  var arrived = {}
  var written = {}
  var status = {}
  var cannotWrite = false
  var lines = String(text || "").split("\n")
  var prefix = dir + "/"
  for (var i = 0; i < lines.length; i++) {
    // curl's exit 23 is a write it could not make: a full disk, or a
    // directory it may not create. It can come with no file name at all,
    // when the whole batch is abandoned.
    if (/^23 /.test(lines[i])) cannotWrite = true
    var match = /^(\d+) (\d{3}) (.+)$/.exec(lines[i])
    if (!match || match[3].indexOf(prefix) !== 0) continue
    var key = match[3].slice(prefix.length)
    if (!isTileKey(key)) continue
    status[key] = Number(match[2])
    if (match[1] === "0") written[key] = true
    if (match[1] === "0" && match[2] === "200") arrived[key] = true
  }
  var result = { arrived: [], failed: [], written: [], cannotWrite: cannotWrite }
  for (var j = 0; j < (jobs || []).length; j++) {
    var k = jobs[j].key
    if (written[k]) result.written.push(k)
    if (arrived[k]) result.arrived.push(k)
    else result.failed.push({ key: k, status: status[k] || 0 })
  }
  return result
}

// Delete a whole frame's tiles, or the whole cache when no frames are named.
// The paths are rebuilt from checked numbers and a checked directory; there
// is no form of call that deletes outside the cache.
function cleanCommand(dir, frameTimes) {
  if (!isCacheDir(dir)) return []
  if (!frameTimes) return ["rm", "-rf", "--", dir]
  var command = ["rm", "-rf", "--"]
  var targets = 0
  for (var i = 0; i < frameTimes.length; i++) {
    if (!isWhole(frameTimes[i], 1, 99999999999)) continue
    command.push(dir + "/" + frameTimes[i])
    targets++
  }
  return targets > 0 ? command : []
}

// The frames whose tiles are on disk but which have left the loop.
function staleFrames(storedFrames, frames) {
  var current = {}
  for (var i = 0; i < (frames || []).length; i++) current[frames[i].time] = true
  var stale = []
  for (var time in storedFrames) {
    if (!current[time]) stale.push(Number(time))
  }
  return stale.sort(function(a, b) { return a - b })
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

// How long to leave a tile before asking for it again. A 429 is RainViewer
// asking for less, so it backs off harder and applies to every tile rather
// than the one that drew it; anything else is one tile's problem.
var RETRY_MAX_MS = 600000

// The first retry of anything but a 429 comes quickly, because the common
// case is a tile of a frame just published that RainViewer is not serving
// yet, and a loop comes back round to that frame within seconds.
// A failure with no status at all, where nothing answered (no network, a
// name that does not resolve, a timeout), costs RainViewer nothing to retry,
// so it is never left longer than half a minute: that is how long a map takes
// to notice the network is back without anyone touching it.
var UNANSWERED_RETRY_MAX_MS = 30000

function retryDelayMs(attempts, status) {
  var n = Math.max(1, Math.min(7, attempts || 1))
  if (status === 429) return Math.min(RETRY_MAX_MS, 60000 * Math.pow(2, n - 1))
  if (n === 1) return 5000
  var delay = Math.min(300000, 15000 * Math.pow(2, n - 2))
  return status === 0 ? Math.min(UNANSWERED_RETRY_MAX_MS, delay) : delay
}

// Whether a wait set for `until` still holds at `now`. No wait is ever set
// further ahead than RETRY_MAX_MS, so one that is further ahead than that
// means the clock moved backwards, and it is over rather than stretched by
// however far the clock went.
function isHeld(until, now) {
  return until > now && until - now <= RETRY_MAX_MS
}

// A tile that arrives whole and still cannot be decoded is not fixed by
// fetching it again straight away, and fetching it on every pass would be
// the load this cache exists to remove. It is tried again after a growing
// delay, and after this many unreadable arrivals not at all until the map is
// opened again.
var UNREADABLE_TRIES = 3

// Marked as unreadable, so that a tile arriving, which revives the tiles that
// failed for want of a network, does not revive this one: the network was
// never its problem.
function unreadableRetry(count, now) {
  return {
    at: now + retryDelayMs(count, 0),
    attempts: count,
    status: 0,
    unreadable: true,
    gaveUp: count >= UNREADABLE_TRIES
  }
}

// Whether a failed tile is still being left alone at `now`.
function isWaiting(retry, now) {
  return !!retry && (retry.gaveUp === true || isHeld(retry.at, now))
}

// Where a layer loads a tile from: its file once it is on disk, "" for one
// that is failing and not worth waiting for, and null for one still coming,
// which the layer counts as outstanding and the crossfade waits on. A tile
// that has failed once is still coming, as tileState says, so a frame just
// published does not fade in with holes where its slowest tiles will be.
function tileSourceFor(fileUrl, onDisk, retry, pausedUntil, now) {
  if (onDisk) return fileUrl
  var state = tileState(false, retry, pausedUntil, now)
  return state === TILE_COMING ? null : ""
}

// The earliest moment a wanted tile's retry, or a rate limit, runs out, or 0
// for none. The service wakes then rather than on its next heartbeat, so a
// quick retry is quick.
function nextWake(retries, wanted, pausedUntil, now) {
  var earliest = isHeld(pausedUntil, now) ? pausedUntil : 0
  for (var key in retries) {
    var retry = retries[key]
    if (!wanted[key] || retry.gaveUp === true || !isHeld(retry.at, now)) continue
    if (earliest === 0 || retry.at < earliest) earliest = retry.at
  }
  return earliest
}

// ---------------------------------------------------------------------------
// What the map says about its tiles
// ---------------------------------------------------------------------------

// Where one tile stands: on disk, still on its way, failed and waiting out a
// retry, or held back because RainViewer answered 429.
var TILE_ON_DISK = "disk"
var TILE_COMING = "coming"
var TILE_FAILED = "failed"
var TILE_LIMITED = "limited"

// A tile that has failed once is still coming: one failure is ordinary, a
// frame's tiles often arriving a little after the frame is announced, and the
// quick retry above usually brings it. It counts as failed when the retry
// fails too. A 429 is different: RainViewer has said no, and the pause it
// starts holds back every tile, so it is reported at once.
function tileState(onDisk, retry, pausedUntil, now) {
  if (onDisk) return TILE_ON_DISK
  if (isWaiting(retry, now)) {
    if (retry.status === 429) return TILE_LIMITED
    return retry.attempts >= 2 || retry.gaveUp === true ? TILE_FAILED : TILE_COMING
  }
  if (isHeld(pausedUntil, now)) return TILE_LIMITED
  return TILE_COMING
}

// A 429 is the one failure that can be named: curl reports the status, and
// it means RainViewer is asking for less. Everything else, from no network to
// a timeout to a server error, looks the same from here and is said the same
// way.
var NOTICE_LIMITED = "Radar paused: RainViewer is limiting requests"
var NOTICE_FAILED = "Couldn't load the radar"
var NOTICE_LOADING = "Loading radar…"

// The line the map shows for the frame on screen, given the state of each of
// its tiles, or "" for none. A tile on disk draws with no network at all, so a
// loop fetched earlier says nothing whatever the connection is doing now. A
// tile still on its way is loading, said as such, since a stretch of map with
// no rain on it reads as clear sky. A failure outranks it, and a rate limit
// outranks both, being the one that says what to expect.
function radarNotice(states) {
  var failed = false
  var loading = false
  for (var i = 0; i < (states || []).length; i++) {
    if (states[i] === TILE_LIMITED) return NOTICE_LIMITED
    if (states[i] === TILE_FAILED) failed = true
    if (states[i] === TILE_COMING) loading = true
  }
  if (failed) return NOTICE_FAILED
  return loading ? NOTICE_LOADING : ""
}

// Whether the loop may move on to a frame, given the state of each of its
// tiles in view. Not while any is still on its way: playing on past a frame
// whose tiles have not arrived shows an empty sky where the rain is. A tile
// that is failing does not hold it, because waiting for it would stop the
// loop for nothing; the map says so instead.
function frameReady(states) {
  for (var i = 0; i < (states || []).length; i++) {
    if (states[i] === TILE_COMING) return false
  }
  return true
}

// How long the loop waits on a frame whose tiles are still arriving before it
// moves on regardless, so that a slow connection slows the loop rather than
// stopping it.
var PLAYBACK_HOLD_MAX_MS = 7000
