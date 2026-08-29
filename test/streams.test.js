const { test } = require("node:test")
const assert = require("node:assert")
const { readFileSync, readdirSync } = require("node:fs")
const { join } = require("node:path")
const { RadarModel } = require("./load.js")

// Every stream that reaches the shell process, pinned by name.
//
// The plugin does not run beside the desktop, it runs inside it: one process
// owns the bar, the panels, the lock screen and the polkit dialog. Anything
// collected whole into it is collected into all of that, so each stream needs a
// ceiling — and the ceilings that get forgotten are the ones nobody has written
// down. This list is the inventory, and the tests below hold the sources to it,
// so a stream added later fails here rather than turning up in a review.

const ROOT = join(__dirname, "..")
const QML = ["BarWidget.qml", "Panel.qml", "Service.qml"]
  .concat(readdirSync(join(ROOT, "ui")).filter(name => name.endsWith(".qml")).map(name => "ui/" + name))

const source = Object.fromEntries(QML.map(name => [name, readFileSync(join(ROOT, name), "utf8")]))
const everything = Object.values(source).join("\n")

// `collects` means the output is read back into this process. `builder` names
// the RadarModel function that constructs the command, which is where the
// ceilings live.
const PROCESSES = [
  { id: "manifestProc", file: "Service.qml", collects: true, builder: "manifestCommand" },
  { id: "forecastProc", file: "Service.qml", collects: true, builder: "forecastCommand" },
  { id: "notifyProc", file: "Service.qml", collects: false, builder: null },
  { id: "geocodeProc", file: "Panel.qml", collects: true, builder: "geocodingCommand" },
  { id: "locationSaveProc", file: "Panel.qml", collects: false, builder: null },
]

// Files read straight into the process, and why each one carries no ceiling of
// its own. Both are deliberate; see the tests for the reasoning.
const FILE_READS = [
  { id: "locationFile", file: "Service.qml" },
  { id: "basemapFile", file: "Service.qml" },
]

function idsOf(pattern) {
  const found = []
  for (const [file, text] of Object.entries(source)) {
    for (const match of text.matchAll(pattern)) found.push({ id: match[1], file })
  }
  return found
}

// ------------------------------------------------------------------ inventory

test("the processes in the sources are the ones written down here", () => {
  const found = idsOf(/Process \{\s*\n\s*id: (\w+)/g)
  assert.deepStrictEqual(
    found.map(p => `${p.file}:${p.id}`).sort(),
    PROCESSES.map(p => `${p.file}:${p.id}`).sort())
})

test("the file reads in the sources are the ones written down here", () => {
  const found = idsOf(/FileView \{\s*\n\s*id: (\w+)/g)
  assert.deepStrictEqual(
    found.map(f => `${f.file}:${f.id}`).sort(),
    FILE_READS.map(f => `${f.file}:${f.id}`).sort())
})

test("only the processes marked as collecting have a collector", () => {
  const collectors = []
  for (const [file, text] of Object.entries(source)) {
    for (const match of text.matchAll(/stdout: StdioCollector \{ id: (\w+)/g)) {
      collectors.push({ file, id: match[1] })
    }
  }
  assert.strictEqual(collectors.length, PROCESSES.filter(p => p.collects).length,
    `collectors found: ${collectors.map(c => c.id).join(", ")}`)
})

// ------------------------------------------------------------------ ceilings

test("every request carries a ceiling on bytes as well as on time", () => {
  // `--max-time` bounds how long a transfer may run, not how much it may
  // deliver: a host that answers fast enough can send as much as the link
  // carries for the whole window.
  for (const name of ["manifestCommand", "geocodingCommand", "forecastCommand"]) {
    const command = name === "manifestCommand" ? RadarModel.manifestCommand()
      : name === "geocodingCommand" ? RadarModel.geocodingCommand("x", 5)
      : RadarModel.forecastCommand([{ latitude: 0, longitude: 0 }], 4, 2)

    assert.strictEqual(command[0], "curl", name)
    assert.ok(command.includes("--max-time"), `${name} has no time limit`)
    assert.ok(command.includes("--max-filesize"), `${name} has no size limit`)
    assert.ok(command.includes("-fsS"), `${name} would parse an error page as data`)

    const bytes = Number(command[command.indexOf("--max-filesize") + 1])
    const seconds = Number(command[command.indexOf("--max-time") + 1])
    assert.ok(bytes > 0 && bytes <= 1024 * 1024, `${name} caps at ${bytes} bytes`)
    assert.ok(seconds > 0 && seconds <= 30, `${name} waits up to ${seconds}s`)
  }
})

test("the ceilings leave room above what the endpoints actually return", () => {
  // Measured against the real endpoints: the RainViewer manifest is 766 bytes,
  // a five-result geocoding answer 1,834, and a five-point forecast at the
  // widest window this plugin asks for 9,269. A ceiling under what the service
  // really sends is an outage nobody would think to look for.
  assert.ok(RadarModel.MANIFEST_MAX_BYTES >= 766 * 10)
  assert.ok(RadarModel.GEOCODING_MAX_BYTES >= 1834 * 10)
  assert.ok(RadarModel.FORECAST_MAX_BYTES >= 9269 * 10)
})

test("no request is built outside the library that puts the ceilings on", () => {
  // A command assembled at a call site is a command that can be written
  // without them.
  for (const [file, text] of Object.entries(source)) {
    for (const match of text.matchAll(/\.command = (\[[^\]]*\])/g)) {
      assert.ok(!match[1].includes('"curl"'),
        `${file} builds a curl command inline: ${match[1]}`)
    }
  }
})

// ------------------------------------------------------------------ answering

test("every collecting process can tell a failure from a fork that never ran", () => {
  // A process that cannot be started emits neither `started` nor `exited` and
  // goes from running to not running in silence, so a flag cleared only by
  // `onExited` sticks for the life of the session.
  for (const process of PROCESSES.filter(p => p.collects)) {
    const block = source[process.file].slice(source[process.file].indexOf(`id: ${process.id}`))
    assert.match(block.slice(0, 1200), /property bool answered: false/,
      `${process.id} has no answered flag`)
    assert.match(block.slice(0, 1200), /onRunningChanged: if \(!running && !answered\)/,
      `${process.id} does not answer a fork that never ran`)
  }
})

test("no decision is taken in a collector, where the exit code does not exist yet", () => {
  // `onStreamFinished` fires before `onExited`, so a transfer cut short by a
  // ceiling would be read there as one that completed.
  // The handler, not the word: the comments above each collector name it.
  assert.ok(!/onStreamFinished\s*:/.test(everything), "a collector is deciding something")
})

test("a flag that gates everything is cleared before the answer can return", () => {
  // `savingLocation` and `checking` gate what comes after them, so if either is
  // left set the plugin does not degrade, it freezes: a spinner that never
  // stops, an alert that never checks again. Clearing them further down, past a
  // guard on the exit code, is the version of this that looks right.
  for (const [fn, flag, file] of [["applyLocationSave", "savingLocation", "Panel.qml"],
                                  ["applyForecastResponse", "checking", "Service.qml"]]) {
    const start = source[file].indexOf(`function ${fn}(`)
    assert.ok(start > 0, `${fn} is missing from ${file}`)
    const body = source[file].slice(start, start + 900)

    const cleared = body.indexOf(`${flag} = false`)
    const returns = body.indexOf("return")
    assert.ok(cleared > 0, `${fn} never clears ${flag}`)
    assert.ok(returns < 0 || cleared < returns,
      `${fn} can return before clearing ${flag}`)
  }
})

// ------------------------------------------------------------------ images

test("the radar tiles are decoded at the size they were asked for", () => {
  // Images are streams too, and their size is decided by whoever serves them —
  // at a host this plugin reads out of a manifest.
  assert.match(source["ui/TileLayer.qml"], /sourceSize: Qt\.size\(/, "tiles decode unbounded")
})

test("the coverage probe is the one image decode without a ceiling, on purpose", () => {
  // Context2D reads pixels from an image it loaded itself. Handed an Image
  // item — which is what would carry a sourceSize — drawImage produces nothing
  // to read, and every location comes back reported as covered. There is no
  // form of this that both bounds the decode and answers the question.
  //
  // Pinned so that removing the exception means removing this test, rather than
  // the ceiling quietly never having been there.
  assert.match(source["ui/CoverageProbe.qml"], /loadImage\(source\)/)
  // The property assignment, not the word: the comment above it names it.
  assert.ok(!/sourceSize\s*:/.test(source["ui/CoverageProbe.qml"]),
    "if this ever gains a sourceSize, check it still reads pixels before believing it")

  // What bounds it instead.
  assert.strictEqual(RadarModel.isTileHost("https://tilecache.rainviewer.com"), true)
  assert.strictEqual(RadarModel.isTileHost("http://elsewhere"), false)
})

test("the host every image URL is built from is checked before it is used", () => {
  assert.strictEqual(RadarModel.isTileHost("https://tilecache.rainviewer.com"), true)
  assert.strictEqual(RadarModel.isTileHost("http://tilecache.rainviewer.com"), false)
  assert.strictEqual(RadarModel.isTileHost("anything at all"), false)
})
