const { test } = require("node:test")
const assert = require("node:assert")
const { TileCache, TileMath } = require("./load.js")

const DIR = "/home/someone/.cache/omarchy/plugins/eduardodallecort.weather-radar/tiles"
const HOST = "https://tilecache.rainviewer.com"
const FRAMES = [
  { time: 1789000000, path: "/v2/radar/1789000000" },
  { time: 1789000600, path: "/v2/radar/1789000600" },
  { time: 1789001200, path: "/v2/radar/1789001200" },
]

// ------------------------------------------------------------------ where the cache lives

test("the cache lives under XDG's cache directory, or under home without one", () => {
  assert.strictEqual(TileCache.cacheDir("/home/someone", ""), DIR)
  assert.strictEqual(TileCache.cacheDir("/home/someone", undefined), DIR)
  assert.strictEqual(TileCache.cacheDir("/home/someone", "/var/cache/someone"),
    "/var/cache/someone/omarchy/plugins/eduardodallecort.weather-radar/tiles")
  assert.strictEqual(TileCache.cacheDir("/home/someone/", ""), DIR)
})

test("a relative or missing home gives no cache rather than a relative one", () => {
  // The directory is what `rm -rf` is pointed at. Relative to whatever the
  // shell's working directory happens to be is not somewhere to point it.
  assert.strictEqual(TileCache.cacheDir("", ""), "")
  assert.strictEqual(TileCache.cacheDir(undefined, undefined), "")
  assert.strictEqual(TileCache.cacheDir("home/someone", ""), "")
  assert.strictEqual(TileCache.cacheDir("/home/someone", "relative/cache"), DIR)
})

test("only a directory ending in the plugin's own cache is accepted", () => {
  assert.strictEqual(TileCache.isCacheDir(DIR), true)
  for (const bad of ["/", "/home/someone", "/home/someone/.cache",
                     "/omarchy/plugins/eduardodallecort.weather-radar/tiles",
                     "/home/someone/../../omarchy/plugins/eduardodallecort.weather-radar/tiles",
                     "/home/some\none/.cache/omarchy/plugins/eduardodallecort.weather-radar/tiles",
                     DIR + "/", DIR + "/..", "relative" + DIR, null, 42]) {
    assert.strictEqual(TileCache.isCacheDir(bad), false, String(bad))
  }
})

test("a cache path that would break a file:// URL gives no cache", () => {
  for (const home of ["/home/we#ird", "/home/pc%41", "/home/why?"]) {
    assert.strictEqual(TileCache.cacheDir(home, ""), "", home)
  }
})

// ------------------------------------------------------------------ tile names

test("a tile is named by its frame's time and its own numbers", () => {
  assert.strictEqual(TileCache.tileKey(1789000000, 7, 46, 74, 2, true, false),
    "1789000000/7/46/74/2_1_0.png")
  assert.strictEqual(TileCache.frameOfKey("1789000000/7/46/74/2_1_0.png"), 1789000000)
})

test("nothing out of range becomes a name", () => {
  const cases = [
    [0, 7, 1, 1, 2], [-5, 7, 1, 1, 2], [1.5, 7, 1, 1, 2], ["1789000000", 7, 1, 1, 2],
    [1789000000, 21, 1, 1, 2], [1789000000, 7, 128, 1, 2], [1789000000, 7, 1, -1, 2],
    [1789000000, 7, 1, 1, 256], [1789000000, 7, 1, 1, "2"], [NaN, 7, 1, 1, 2],
    [1789000000, 7, Infinity, 1, 2],
  ]
  for (const [time, z, x, y, scheme] of cases) {
    assert.strictEqual(TileCache.tileKey(time, z, x, y, scheme, true, true), "",
      JSON.stringify([time, z, x, y, scheme]))
  }
})

test("a name that did not come from tileKey is not taken for one", () => {
  for (const bad of ["../../etc/passwd", "1789000000/7/46/74/2_1_0.png/../x",
                     "/1789000000/7/46/74/2_1_0.png", "1789000000/7/46/74/2_1_0.jpg",
                     "a/7/46/74/2_1_0.png", "", null]) {
    assert.strictEqual(TileCache.isTileKey(bad), false, String(bad))
  }
})

// ------------------------------------------------------------------ what to fetch

test("a view asks for the same tiles the layer lays out", () => {
  const tiles = TileCache.viewTiles(0, 0, 7, 900, 600)
  const view = TileMath.viewportTiles(0, 0, 7, 900, 600)
  assert.strictEqual(tiles.length, (view.maxX - view.minX + 1) * (view.maxY - view.minY + 1))
  for (const t of tiles) {
    assert.ok(t.x >= 0 && t.x < 128 && t.y >= 0 && t.y < 128)
  }
})

test("a view across the antimeridian asks for each tile once", () => {
  // At zoom 1 a wide view wraps round the whole world, and the same tile
  // column comes up twice. Fetching it twice would be two requests for one file.
  const tiles = TileCache.viewTiles(0, 179, 1, 2048, 512)
  const names = tiles.map(t => t.x + "," + t.y)
  assert.strictEqual(new Set(names).size, names.length)
})

test("the loop is fetched from the frame on screen onwards, wrapping round", () => {
  const tiles = [{ x: 1, y: 2 }, { x: 2, y: 2 }]
  const jobs = TileCache.loopJobs(HOST, FRAMES, 1, tiles, 7, 2, true, false)
  assert.deepStrictEqual(jobs.map(j => TileCache.frameOfKey(j.key)),
    [1789000600, 1789000600, 1789001200, 1789001200, 1789000000, 1789000000])
  assert.strictEqual(jobs[0].url, HOST + "/v2/radar/1789000600/256/7/1/2/2/1_0.png")
  assert.strictEqual(jobs[0].key, "1789000600/7/1/2/2_1_0.png")
})

test("a limited request stops after that many frames of the loop", () => {
  const tiles = [{ x: 1, y: 2 }]
  const jobs = TileCache.loopJobs(HOST, FRAMES, 2, tiles, 7, 2, true, false, 2)
  assert.deepStrictEqual(jobs.map(j => TileCache.frameOfKey(j.key)), [1789001200, 1789000000])
  assert.strictEqual(TileCache.loopJobs(HOST, FRAMES, 0, tiles, 7, 2, true, false).length, 3)
  assert.strictEqual(TileCache.loopJobs(HOST, FRAMES, 0, tiles, 7, 2, true, false, 99).length, 3)
})

test("a start past the end of the loop starts from its beginning", () => {
  const jobs = TileCache.loopJobs(HOST, FRAMES, 9, [{ x: 1, y: 2 }], 7, 2, true, false)
  assert.strictEqual(TileCache.frameOfKey(jobs[0].key), 1789000000)
})

test("the loop asks for nothing without a host it trusts", () => {
  const tiles = [{ x: 1, y: 2 }]
  assert.deepStrictEqual(TileCache.loopJobs("http://elsewhere", FRAMES, 0, tiles, 7, 2, true, false), [])
  assert.deepStrictEqual(TileCache.loopJobs(HOST, [], 0, tiles, 7, 2, true, false), [])
})

test("two maps' requests are taken in turn, and a tile both want is fetched once", () => {
  const a = [{ key: "a1" }, { key: "shared" }, { key: "a3" }]
  const b = [{ key: "b1" }, { key: "b2" }, { key: "shared" }, { key: "b4" }]
  assert.deepStrictEqual(TileCache.interleave([a, b]).map(j => j.key),
    ["a1", "b1", "shared", "b2", "a3", "b4"])
  assert.deepStrictEqual(TileCache.interleave([]), [])
  assert.deepStrictEqual(TileCache.interleave([a]).map(j => j.key), ["a1", "shared", "a3"])
})

// ------------------------------------------------------------------ the fetch command

test("the fetch command carries a ceiling on bytes and time, and writes only whole tiles", () => {
  const jobs = TileCache.loopJobs(HOST, FRAMES, 0, [{ x: 1, y: 2 }], 7, 2, true, false)
  const command = TileCache.fetchCommand(DIR, jobs)
  assert.strictEqual(command[0], "curl")
  assert.ok(command.includes("-fs"), "an HTTP error would be saved as a tile")
  assert.ok(command.includes("--remove-on-error"), "a failed transfer would leave part of a file")
  const bytes = Number(command[command.indexOf("--max-filesize") + 1])
  const seconds = Number(command[command.indexOf("--max-time") + 1])
  assert.ok(bytes >= 8192 * 10 && bytes <= 1024 * 1024, `caps at ${bytes} bytes`)
  assert.ok(seconds > 0 && seconds <= 30, `waits up to ${seconds}s`)
  // Each URL is followed by where it goes, and every destination is inside the cache.
  const outputs = command.map((arg, i) => arg === "-o" ? command[i + 1] : null).filter(Boolean)
  assert.strictEqual(outputs.length, jobs.length)
  for (const out of outputs) assert.ok(out.startsWith(DIR + "/"), out)
})

test("every tile command turns URL globbing off and fetches only over https", () => {
  const command = TileCache.fetchCommand(DIR, TileCache.loopJobs(HOST, FRAMES, 0, [{ x: 1, y: 2 }], 7, 2, true, false))
  assert.ok(command.includes("--globoff"))
  assert.strictEqual(command[command.indexOf("--proto") + 1], "=https")
})

test("a batch never holds more transfers than a batch is allowed", () => {
  const tiles = []
  for (let x = 0; x < 10; x++) tiles.push({ x, y: 2 })
  const jobs = TileCache.loopJobs(HOST, FRAMES, 0, tiles, 7, 2, true, false)
  assert.ok(jobs.length > TileCache.BATCH_SIZE)
  const command = TileCache.fetchCommand(DIR, jobs)
  assert.strictEqual(command.filter(arg => arg === "-o").length, TileCache.BATCH_SIZE)
})

test("the fetch command refuses a directory or a job it cannot vouch for", () => {
  const jobs = [{ key: "1789000000/7/1/2/2_1_0.png", url: HOST + "/x.png" }]
  assert.deepStrictEqual(TileCache.fetchCommand("/tmp", jobs), [])
  assert.deepStrictEqual(TileCache.fetchCommand(DIR, []), [])
  assert.deepStrictEqual(TileCache.fetchCommand(DIR, [{ key: "../../x", url: HOST + "/x.png" }]), [])
  assert.deepStrictEqual(TileCache.fetchCommand(DIR, [{ key: jobs[0].key, url: "file:///etc/passwd" }]), [])
  assert.deepStrictEqual(TileCache.fetchCommand(DIR, [{ key: jobs[0].key, url: "http://plain/x.png" }]), [])
})

test("a frame path curl would expand into more URLs never reaches it", () => {
  // curl reads [1-100000000] or {a,b} in a URL as a list to fetch, each with a
  // line in the report the shell collects. The parser refuses such paths
  // (radar-model.test.js); the jobs and the command refuse them again.
  const hostile = [
    "/v2/radar/[0-99999999]", "/v2/radar/{a,b,c}", "/v2/radar/x?y=1", "/v2/radar/../x",
    "/v2/radar/a b", "/v2/radar/%5B0-9%5D", "v2/radar/x", "/v2/radar/x#y", "/v2//radar",
  ]
  for (const path of hostile) {
    const jobs = TileCache.loopJobs(HOST, [{ time: 1789000000, path }], 0, [{ x: 1, y: 2 }], 7, 2, true, false)
    assert.deepStrictEqual(TileCache.fetchCommand(DIR, jobs), [], path)
  }
})

// ------------------------------------------------------------------ what curl reports

test("curl's report is read back as the tiles that arrived and the ones that did not", () => {
  const jobs = [
    { key: "1789000000/7/1/2/2_1_0.png" },
    { key: "1789000000/7/2/2/2_1_0.png" },
    { key: "1789000000/7/3/2/2_1_0.png" },
    { key: "1789000000/7/4/2/2_1_0.png" },
  ]
  const report = [
    `0 200 ${DIR}/${jobs[0].key}`,
    `22 429 ${DIR}/${jobs[1].key}`,
    `63 200 ${DIR}/${jobs[2].key}`,
    "",
  ].join("\n")
  const result = TileCache.parseFetchReport(report, DIR, jobs)
  assert.deepStrictEqual(result.arrived, [jobs[0].key])
  assert.deepStrictEqual(result.failed, [
    { key: jobs[1].key, status: 429 },
    { key: jobs[2].key, status: 200 },
    // Not in the report at all: the process died, and nothing it left is trusted.
    { key: jobs[3].key, status: 0 },
  ])
})

test("a report line naming a file outside the cache is ignored", () => {
  const jobs = [{ key: "1789000000/7/1/2/2_1_0.png" }]
  const result = TileCache.parseFetchReport("0 200 /tmp/1789000000/7/1/2/2_1_0.png\n", DIR, jobs)
  assert.deepStrictEqual(result.arrived, [])
})

test("a redirect's body is reported as written but not as a tile", () => {
  const jobs = [{ key: "1789000000/7/1/2/2_1_0.png" }, { key: "1789000000/7/2/2/2_1_0.png" }]
  const report = `0 302 ${DIR}/${jobs[0].key}\n22 429 ${DIR}/${jobs[1].key}\n`
  const result = TileCache.parseFetchReport(report, DIR, jobs)
  assert.deepStrictEqual(result.arrived, [])
  assert.deepStrictEqual(result.written, [jobs[0].key])
  assert.deepStrictEqual(result.failed.map(f => f.status), [302, 429])
})

test("a write curl could not make is reported, with or without a file name", () => {
  const jobs = [{ key: "1789000000/7/1/2/2_1_0.png" }]
  assert.strictEqual(TileCache.parseFetchReport(`23 200 ${DIR}/${jobs[0].key}\n`, DIR, jobs).cannotWrite, true)
  assert.strictEqual(TileCache.parseFetchReport("23 000 \n", DIR, jobs).cannotWrite, true)
  assert.strictEqual(TileCache.parseFetchReport(`0 200 ${DIR}/${jobs[0].key}\n`, DIR, jobs).cannotWrite, false)
})

// ------------------------------------------------------------------ what leaves the cache

test("cleaning deletes frame directories inside the cache and nothing else", () => {
  assert.deepStrictEqual(TileCache.cleanCommand(DIR, [1789000000, 1789000600]),
    ["rm", "-rf", "--", DIR + "/1789000000", DIR + "/1789000600"])
  assert.deepStrictEqual(TileCache.cleanCommand(DIR, null), ["rm", "-rf", "--", DIR])
  assert.deepStrictEqual(TileCache.cleanCommand(DIR, ["..", "1789000000/../..", -1, 1.5]), [])
  assert.deepStrictEqual(TileCache.cleanCommand(DIR, []), [])
  assert.deepStrictEqual(TileCache.cleanCommand("/home/someone", null), [])
  assert.deepStrictEqual(TileCache.cleanCommand("/", [1789000000]), [])
})

test("a frame that has left the loop is stale, and one still in it is not", () => {
  const stored = { 1788999400: true, 1789000000: true, 1789001200: true }
  assert.deepStrictEqual(TileCache.staleFrames(stored, FRAMES), [1788999400])
  assert.deepStrictEqual(TileCache.staleFrames({}, FRAMES), [])
  assert.deepStrictEqual(TileCache.staleFrames(stored, []), [1788999400, 1789000000, 1789001200])
})

test("the cache has a ceiling on tiles as well as on each tile", () => {
  assert.ok(TileCache.MAX_TILES_ON_DISK >= 13 * 20 * 4, "not even a few views' loops fit")
  assert.ok(TileCache.MAX_TILES_ON_DISK * TileCache.TILE_MAX_BYTES <= 512 * 1024 * 1024,
    "the directory could grow past half a gigabyte")
})

// ------------------------------------------------------------------ retries

test("a rate limit backs off harder than a failed tile, and neither without bound", () => {
  assert.strictEqual(TileCache.retryDelayMs(1, 429), 60000)
  assert.strictEqual(TileCache.retryDelayMs(2, 429), 120000)
  assert.strictEqual(TileCache.retryDelayMs(99, 429), 600000)
  // The first retry of a plain failure is quick; the ones after it back off.
  assert.strictEqual(TileCache.retryDelayMs(1, 404), 5000)
  assert.strictEqual(TileCache.retryDelayMs(1, 0), 5000)
  assert.strictEqual(TileCache.retryDelayMs(2, 0), 15000)
  assert.strictEqual(TileCache.retryDelayMs(3, 0), 30000)
  assert.strictEqual(TileCache.retryDelayMs(99, 500), 300000)
  assert.ok(TileCache.retryDelayMs(1, 429) > TileCache.retryDelayMs(1, 500))
})

test("a failure nothing answered is retried within half a minute, however often", () => {
  assert.strictEqual(TileCache.retryDelayMs(4, 0), 30000)
  assert.strictEqual(TileCache.retryDelayMs(40, 0), 30000)
  // A server's error still backs off further.
  assert.strictEqual(TileCache.retryDelayMs(4, 503), 60000)
})

test("a wait further ahead than any wait is set means the clock went back, and is over", () => {
  const now = 1_000_000
  assert.strictEqual(TileCache.isHeld(now + 60000, now), true)
  assert.strictEqual(TileCache.isHeld(now + TileCache.RETRY_MAX_MS, now), true)
  assert.strictEqual(TileCache.isHeld(now + TileCache.RETRY_MAX_MS + 1, now), false)
  assert.strictEqual(TileCache.isHeld(now - 1, now), false)
  // A 429 pause set an hour ahead of a clock that then went back an hour.
  assert.strictEqual(TileCache.tileState(false, null, now + 3600000, now), "coming")
  assert.strictEqual(TileCache.tileState(false, { at: now + 3600000, status: 429 }, 0, now), "coming")
})

test("an unreadable tile waits longer each time it comes back, then is left alone", () => {
  const now = 1_000_000
  const first = TileCache.unreadableRetry(1, now)
  const second = TileCache.unreadableRetry(2, now)
  const third = TileCache.unreadableRetry(TileCache.UNREADABLE_TRIES, now)
  assert.ok(second.at - now > first.at - now)
  assert.strictEqual(first.gaveUp, false)
  assert.strictEqual(third.gaveUp, true)
  // Marked, so that the network coming back is not mistaken for a cure.
  assert.strictEqual(first.unreadable, true)
  // Left alone for good, not until some time passes.
  assert.strictEqual(TileCache.isWaiting(third, now + 365 * 86400000), true)
  assert.strictEqual(TileCache.tileState(false, third, 0, now + 365 * 86400000), "failed")
  assert.strictEqual(TileCache.isWaiting(first, first.at + 1), false)
})

test("the service wakes when the next wanted retry or rate limit runs out", () => {
  const now = 1_000_000
  const retries = {
    a: { at: now + 5000, status: 0, attempts: 1 },
    b: { at: now + 2000, status: 0, attempts: 1 },
    c: { at: now + 1000, status: 0, attempts: 1 },            // not wanted
    d: { at: now + 500, status: 0, attempts: 3, gaveUp: true }, // left alone
    e: { at: now - 1, status: 0, attempts: 1 },                // already due
  }
  const wanted = { a: true, b: true, d: true, e: true }
  assert.strictEqual(TileCache.nextWake(retries, wanted, 0, now), now + 2000)
  assert.strictEqual(TileCache.nextWake(retries, wanted, now + 1500, now), now + 1500)
  assert.strictEqual(TileCache.nextWake({}, {}, 0, now), 0)
})

// ------------------------------------------------------------------ what the map shows

test("a tile's state follows the disk first, then its retry, then a rate limit", () => {
  const now = 1000
  assert.strictEqual(TileCache.tileState(true, { at: 5000, status: 429 }, 5000, now), "disk")
  assert.strictEqual(TileCache.tileState(false, { at: 5000, status: 429 }, 0, now), "limited")
  // Failed once: still coming, the quick retry usually brings it.
  assert.strictEqual(TileCache.tileState(false, { at: 5000, status: 0, attempts: 1 }, 0, now), "coming")
  // Failed again: failed.
  assert.strictEqual(TileCache.tileState(false, { at: 5000, status: 0, attempts: 2 }, 0, now), "failed")
  assert.strictEqual(TileCache.tileState(false, { at: 5000, status: 503, attempts: 3 }, 0, now), "failed")
  // A 429 is reported at once.
  assert.strictEqual(TileCache.tileState(false, { at: 5000, status: 429, attempts: 1 }, 0, now), "limited")
  // Queued behind a 429 without having failed itself.
  assert.strictEqual(TileCache.tileState(false, null, 5000, now), "limited")
  // A retry whose time has come is on its way again.
  assert.strictEqual(TileCache.tileState(false, { at: 500, status: 0 }, 0, now), "coming")
  assert.strictEqual(TileCache.tileState(false, null, 0, now), "coming")
})

test("a tile that failed once is still waited for, so a new frame does not fade in with holes", () => {
  const now = 1_000_000
  const url = "file:///c/t.png"
  assert.strictEqual(TileCache.tileSourceFor(url, true, null, 0, now), url)
  assert.strictEqual(TileCache.tileSourceFor(url, false, null, 0, now), null)
  assert.strictEqual(TileCache.tileSourceFor(url, false, { at: now + 5000, status: 0, attempts: 1 }, 0, now), null)
  // Failed twice, refused, or held back by a rate limit: not worth waiting for.
  assert.strictEqual(TileCache.tileSourceFor(url, false, { at: now + 15000, status: 0, attempts: 2 }, 0, now), "")
  assert.strictEqual(TileCache.tileSourceFor(url, false, { at: now + 60000, status: 429, attempts: 1 }, 0, now), "")
  assert.strictEqual(TileCache.tileSourceFor(url, false, null, now + 60000, now), "")
})

test("the map says nothing over tiles on disk, however the network is doing", () => {
  // Frames fetched earlier and drawn with no connection are the healthy case a
  // message about failing tiles must not be raised over.
  assert.strictEqual(TileCache.radarNotice(["disk", "disk"]), "")
  assert.strictEqual(TileCache.radarNotice([]), "")
})

test("and says it is loading while a tile it shows is on its way", () => {
  // An empty stretch of map reads as clear sky, so a tile still coming is said.
  assert.strictEqual(TileCache.radarNotice(["disk", "disk", "coming"]), TileCache.NOTICE_LOADING)
})

test("a failure outranks loading, and a rate limit is named above both", () => {
  assert.strictEqual(TileCache.radarNotice(["disk", "failed", "coming"]), TileCache.NOTICE_FAILED)
  assert.strictEqual(TileCache.radarNotice(["coming", "failed", "limited"]), TileCache.NOTICE_LIMITED)
  assert.match(TileCache.NOTICE_LIMITED, /RainViewer/)
})

// ------------------------------------------------------------------ the loop waits for its frames

test("the loop waits on a frame whose tiles are still coming", () => {
  assert.strictEqual(TileCache.frameReady(["disk", "disk", "coming"]), false)
  assert.strictEqual(TileCache.frameReady(["disk", "disk"]), true)
  assert.strictEqual(TileCache.frameReady([]), true)
})

test("but not on one whose tiles are failing, which the map reports instead", () => {
  assert.strictEqual(TileCache.frameReady(["disk", "failed"]), true)
  assert.strictEqual(TileCache.frameReady(["limited", "limited"]), true)
})

test("and not for long, so a slow connection slows the loop without stopping it", () => {
  assert.ok(TileCache.PLAYBACK_HOLD_MAX_MS > 1000 && TileCache.PLAYBACK_HOLD_MAX_MS <= 10000)
})
