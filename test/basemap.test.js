const { test } = require("node:test")
const assert = require("node:assert")
const { readFileSync } = require("node:fs")
const { join } = require("node:path")
const { loadLibrary, TileMath } = require("./load.js")

const Basemap = loadLibrary("Basemap.js", { TileMath })

const QUANTUM = 1000

// ---------------------------------------------------------------------------
// An encoder, written here rather than imported.
//
// tools/build-basemap.py writes the file; this writes the same format from the
// specification. A decoder tested only against its own encoder proves the two
// agree, not that either is right — and the real file below is checked against
// this one, so a change to either side has to be a deliberate change to both.
// ---------------------------------------------------------------------------

function varint(value, out) {
  while (true) {
    const byte = value & 0x7F
    value >>>= 7
    if (value) out.push(byte | 0x80)
    else { out.push(byte); return }
  }
}

function signed(value, out) {
  varint(value < 0 ? (-value * 2) - 1 : value * 2, out)
}

function string(text, out) {
  const bytes = Buffer.from(text, "utf8")
  varint(bytes.length, out)
  for (const byte of bytes) out.push(byte)
}

// layers: [{name, kind, minZoom, maxZoom, features}] where a geometry feature
// is an array of rings, each an array of [x, y] in quantised units.
function encode(layers, options) {
  const settings = options || {}
  const out = []
  for (const character of settings.magic === undefined ? "OWRB" : settings.magic) {
    out.push(character.charCodeAt(0))
  }
  out.push(settings.version === undefined ? 1 : settings.version)
  varint(settings.quantum === undefined ? QUANTUM : settings.quantum, out)
  varint(layers.length, out)

  for (const layer of layers) {
    string(layer.name, out)
    out.push(layer.kind, layer.minZoom, layer.maxZoom)

    if (layer.kind === 2) {
      varint(layer.places.length, out)
      let previousX = 0, previousY = 0
      for (const place of layer.places) {
        signed(place.x - previousX, out)
        signed(place.y - previousY, out)
        out.push(place.minZoom)
        string(place.name, out)
        previousX = place.x
        previousY = place.y
      }
      continue
    }

    varint(layer.features.length, out)
    for (const rings of layer.features) {
      varint(rings.length, out)
      for (const ring of rings) {
        varint(ring.length, out)
        let previousX = 0, previousY = 0
        for (const [x, y] of ring) {
          signed(x - previousX, out)
          signed(y - previousY, out)
          previousX = x
          previousY = y
        }
      }
    }
  }
  return Uint8Array.from(out).buffer
}

const SIMPLE = [
  {
    name: "land", kind: 1, minZoom: 3, maxZoom: 9,
    features: [
      // A square degree at the origin, with a square hole in the middle.
      [[[0, 0], [1000, 0], [1000, 1000], [0, 1000], [0, 0]],
       [[250, 250], [750, 250], [750, 750], [250, 750], [250, 250]]],
      // A far-away island, so culling has something to reject.
      [[[100000, 40000], [101000, 40000], [101000, 41000], [100000, 41000]]]
    ]
  },
  {
    name: "places", kind: 2, minZoom: 3, maxZoom: 9,
    places: [
      { x: -46633, y: -23550, minZoom: 3, name: "São Paulo" },
      { x: 6957, y: 50938, minZoom: 5, name: "Köln" },
      { x: 13000, y: 55605, minZoom: 7, name: "Malmö" }
    ]
  }
]

// ---------------------------------------------------------------------------
// Round-trip
// ---------------------------------------------------------------------------

test("a geometry layer survives encoding and decoding unchanged", () => {
  const map = Basemap.decode(encode(SIMPLE))
  assert.notStrictEqual(map, null)
  assert.strictEqual(map.quantum, QUANTUM)
  assert.deepStrictEqual(map.order, ["land", "places"])

  const land = map.layers.land
  assert.strictEqual(land.kind, 1)
  assert.strictEqual(land.featureCount, 2)

  // The first feature keeps both of its rings, in order, with every point.
  assert.strictEqual(land.featureRing[1] - land.featureRing[0], 2)
  const outerStart = land.ringStart[0]
  assert.deepStrictEqual(
    Array.from(land.coordinates.slice(outerStart * 2, outerStart * 2 + 10)),
    [0, 0, 1000, 0, 1000, 1000, 0, 1000, 0, 0])
})

test("decoding computes each feature's bounding box from its own points", () => {
  const land = Basemap.decode(encode(SIMPLE)).layers.land
  assert.deepStrictEqual(Array.from(land.bounds.slice(0, 4)), [0, 0, 1000, 1000])
  assert.deepStrictEqual(Array.from(land.bounds.slice(4, 8)), [100000, 40000, 101000, 41000])
})

test("place names round-trip through UTF-8 by hand", () => {
  // QML's JavaScript engine has no TextDecoder, so the decoder spells UTF-8
  // out. Accented names are the ordinary case, not an edge one.
  const places = Basemap.decode(encode(SIMPLE)).layers.places.places
  assert.deepStrictEqual(places.map(p => p.name), ["São Paulo", "Köln", "Malmö"])
  assert.strictEqual(places[0].minZoom, 3)
  assert.ok(Math.abs(places[0].latitude - -23.55) < 1e-9)
  assert.ok(Math.abs(places[0].longitude - -46.633) < 1e-9)
})

// ---------------------------------------------------------------------------
// Refusing what it cannot read
// ---------------------------------------------------------------------------

test("an unreadable file yields null rather than throwing", () => {
  // A basemap that fails to load leaves the radar over empty ground, which is
  // a degraded map. An exception during startup is a broken shell.
  assert.strictEqual(Basemap.decode(null), null)
  assert.strictEqual(Basemap.decode(new Uint8Array(0).buffer), null)
  assert.strictEqual(Basemap.decode(Uint8Array.from([1, 2, 3]).buffer), null)
  assert.strictEqual(Basemap.decode(encode(SIMPLE, { magic: "XXXX" })), null,
    "wrong magic")
  assert.strictEqual(Basemap.decode(encode(SIMPLE, { version: 99 })), null,
    "a format from the future")
  assert.strictEqual(Basemap.decode(encode(SIMPLE, { quantum: 0 })), null,
    "a quantum of zero would divide by zero on every point")
})

test("a truncated file yields null rather than half a map", () => {
  const full = new Uint8Array(encode(SIMPLE))
  for (const fraction of [0.2, 0.5, 0.9]) {
    const cut = full.slice(0, Math.floor(full.length * fraction))
    const map = Basemap.decode(cut.buffer)
    assert.strictEqual(map, null, `truncated to ${fraction}`)
  }
})

// ---------------------------------------------------------------------------
// Culling
// ---------------------------------------------------------------------------

function view(zoom, latitude, longitude) {
  return { centerLatitude: latitude, centerLongitude: longitude, zoom: zoom, width: 700, height: 320 }
}

test("a viewport's bounds contain its own centre and grow with zooming out", () => {
  const wide = Basemap.viewBounds(view(3, 0, 0))
  const tight = Basemap.viewBounds(view(9, 0, 0))
  assert.ok(wide.west < 0 && wide.east > 0 && wide.south < 0 && wide.north > 0)
  assert.ok(wide.east - wide.west > tight.east - tight.west, "z3 is wider than z9")
  assert.ok(tight.north > 0 && tight.south < 0)
})

test("culling keeps what meets the viewport and rejects what does not", () => {
  const land = Basemap.decode(encode(SIMPLE)).layers.land

  const atOrigin = Basemap.featuresInBounds(land, Basemap.viewBounds(view(9, 0.5, 0.5)))
  assert.deepStrictEqual(atOrigin, [0], "the square at the origin, and not the island")

  const atIsland = Basemap.featuresInBounds(land, Basemap.viewBounds(view(9, 40.5, 100.5)))
  assert.deepStrictEqual(atIsland, [1])

  const empty = Basemap.featuresInBounds(land, Basemap.viewBounds(view(9, -40, -140)))
  assert.deepStrictEqual(empty, [], "open ocean holds no land")
})

test("a layer only applies inside the zoom range it declares", () => {
  const layer = { minZoom: 6, maxZoom: 9 }
  assert.strictEqual(Basemap.layerAppliesAt(layer, 5), false)
  assert.strictEqual(Basemap.layerAppliesAt(layer, 6), true)
  assert.strictEqual(Basemap.layerAppliesAt(layer, 9), true)
  assert.strictEqual(Basemap.layerAppliesAt(layer, 10), false)
  assert.strictEqual(Basemap.layerAppliesAt(null, 7), false)
})

// ---------------------------------------------------------------------------
// Projection into the viewport
// ---------------------------------------------------------------------------

test("a feature at the centre of the view projects to the centre of the canvas", () => {
  const land = Basemap.decode(encode(SIMPLE)).layers.land
  const where = view(9, 0.5, 0.5)
  const paths = Basemap.featurePaths(land, 0, where, 0)

  assert.strictEqual(paths.length, 2, "outer ring and hole")
  // The square spans 0..1 degrees and the view is centred on 0.5, 0.5, so its
  // corners straddle the middle of the canvas.
  const xs = paths[0].filter((_, i) => i % 2 === 0)
  const ys = paths[0].filter((_, i) => i % 2 === 1)
  assert.ok(Math.min(...xs) < where.width / 2 && Math.max(...xs) > where.width / 2)
  assert.ok(Math.min(...ys) < where.height / 2 && Math.max(...ys) > where.height / 2)
})

test("thinning drops points that would land on top of each other", () => {
  // A ring of 200 points inside a thousandth of a degree: at any zoom this map
  // reaches, they occupy well under a pixel.
  // 200 points spanning two tenths of a degree. At z3 that whole run is about
  // a pixel wide, so nearly all of it is redundant; at z9 it is 70 pixels and
  // most of it is not.
  const dense = []
  for (let i = 0; i < 200; i++) dense.push([i, i])
  dense.push([0, 0])
  const layer = Basemap.decode(encode([
    { name: "dense", kind: 0, minZoom: 3, maxZoom: 9, features: [[dense]] }
  ])).layers.dense

  assert.strictEqual(Basemap.featurePaths(layer, 0, view(9, 0, 0), 0)[0].length / 2, 201,
    "a zero step keeps everything")

  const wide = Basemap.featurePaths(layer, 0, view(3, 0, 0), 0.7)[0].length / 2
  const close = Basemap.featurePaths(layer, 0, view(9, 0, 0), 0.7)[0].length / 2
  assert.ok(wide <= 4, `zoomed out this should be a couple of points, got ${wide}`)
  assert.ok(close > wide, "zoomed in, the same geometry keeps more of itself")
  assert.ok(close < 201, "and still drops the points under half a pixel apart")
})

test("the last point of a ring is never thinned away", () => {
  // Dropping it would leave a polygon's closing edge cutting across the shape.
  const ring = [[0, 0], [5000, 0], [5000, 5000], [1, 1], [0, 0]]
  const layer = Basemap.decode(encode([
    { name: "square", kind: 1, minZoom: 3, maxZoom: 9, features: [[ring]] }
  ])).layers.square

  const path = Basemap.featurePaths(layer, 0, view(6, 2.5, 2.5), 4)[0]
  const first = [path[0], path[1]]
  const last = [path[path.length - 2], path[path.length - 1]]
  assert.ok(Math.abs(first[0] - last[0]) < 1e-6 && Math.abs(first[1] - last[1]) < 1e-6,
    "the ring still closes on the point it started from")
})

test("a run of points outside the same edge collapses to one", () => {
  // A bounding box that meets the viewport does not mean the shape does. A
  // river crossing a continent would otherwise contribute thousands of points
  // that fall outside the canvas.
  const line = [[0, 0]]
  for (let i = 1; i <= 500; i++) line.push([i * 100, 0])
  const layer = Basemap.decode(encode([
    { name: "river", kind: 0, minZoom: 3, maxZoom: 9, features: [[line]] }
  ])).layers.river

  // Centred at the western end and zoomed in, so almost all of it is off the
  // eastern edge.
  const path = Basemap.featurePaths(layer, 0, view(9, 0, 0), 0.7)[0]
  assert.ok(path.length / 2 < 40, `expected the tail to collapse, got ${path.length / 2}`)
  // The line still reaches past the right-hand edge, so what remains on screen
  // is drawn to the edge rather than stopping short.
  const xs = path.filter((_, i) => i % 2 === 0)
  assert.ok(Math.max(...xs) > 700, "the path still leaves the canvas")
})

test("a point on screen between two off it is not collapsed away", () => {
  // The reduction folds three points that are outside the same edge into two.
  // Judging it on the anchor and the newcomer alone is not enough: a ring that
  // leaves the viewport, comes back and leaves the same side again has those
  // two outside while the point between them — the only part anybody can see —
  // is in the middle of the map. Dropping it took the whole excursion, and a
  // feature made of nothing else was not drawn at all.
  const ring = [[-3000, 0], [0, 0], [-3000, 0], [-4000, 0], [-5000, 0]]
  const layer = Basemap.decode(encode([
    { name: "river", kind: 0, minZoom: 3, maxZoom: 9, features: [[ring]] }
  ])).layers.river

  const path = Basemap.featurePaths(layer, 0, view(9, 0, 0), 0.7)[0]
  const xs = path.filter((_, i) => i % 2 === 0)
  assert.ok(xs.some(x => x > 0 && x < 700),
    `the vertex inside the viewport survives, got ${JSON.stringify(xs)}`)
})

test("asking for a feature that is not there is empty, not an error", () => {
  const land = Basemap.decode(encode(SIMPLE)).layers.land
  assert.deepStrictEqual(Basemap.featurePaths(land, -1, view(9, 0, 0)), [])
  assert.deepStrictEqual(Basemap.featurePaths(land, 99, view(9, 0, 0)), [])
  assert.deepStrictEqual(Basemap.featurePaths(null, 0, view(9, 0, 0)), [])
})

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

test("a place is labelled only once the map is zoomed in far enough for it", () => {
  const places = Basemap.decode(encode(SIMPLE)).layers.places
  const at = zoom => Basemap.placesInView(places, view(zoom, 55.605, 13), { zoomAllowance: 0 })
    .map(place => place.name)

  assert.deepStrictEqual(at(3), [], "nothing at this zoom is near Malmö")
  assert.deepStrictEqual(at(7), ["Malmö"])
})

test("labels that would overlap yield to the more significant one", () => {
  // Two places a hair apart. The one Natural Earth marks as visible sooner is
  // the one a reader needs; taking whichever came first in the file would give
  // a different answer on every rebuild.
  const layer = Basemap.decode(encode([
    { name: "places", kind: 2, minZoom: 3, maxZoom: 9, places: [
      { x: 0, y: 0, minZoom: 8, name: "Minor" },
      { x: 10, y: 0, minZoom: 4, name: "Major" }
    ] }
  ])).layers.places

  const shown = Basemap.placesInView(layer, view(9, 0, 0.005), {})
  assert.deepStrictEqual(shown.map(place => place.name), ["Major"])
})

test("labels are capped so a dense region cannot flood the map", () => {
  const many = []
  for (let i = 0; i < 200; i++) many.push({ x: i * 20, y: 0, minZoom: 3, name: "P" + i })
  const layer = Basemap.decode(encode([
    { name: "places", kind: 2, minZoom: 3, maxZoom: 9, places: many }
  ])).layers.places

  const shown = Basemap.placesInView(layer, view(9, 0, 2), { limit: 5, labelWidth: 1, labelHeight: 1 })
  assert.strictEqual(shown.length, 5)
})

test("a place outside the canvas is not labelled on its edge", () => {
  const places = Basemap.decode(encode(SIMPLE)).layers.places
  const shown = Basemap.placesInView(places, view(9, 0, 0), {})
  assert.deepStrictEqual(shown, [], "nothing in SIMPLE is near 0,0")
})

// ---------------------------------------------------------------------------
// The file that actually ships
// ---------------------------------------------------------------------------

const shipped = (() => {
  const file = readFileSync(join(__dirname, "..", "data", "basemap.bin"))
  return Basemap.decode(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength))
})()

test("the shipped basemap decodes", () => {
  assert.notStrictEqual(shipped, null, "data/basemap.bin is unreadable")
  assert.strictEqual(shipped.quantum, QUANTUM)
})

test("every hole in the shipped basemap is wound against the ring it sits in", () => {
  // The renderer fills with the nonzero winding rule, which is what QtQuick's
  // Context2D does whatever argument fill() is handed. Under that rule a hole
  // subtracts only if it runs opposite the exterior around it. Nothing at
  // render time can tell the difference — a same-wound hole is painted as
  // land, and a lake quietly becomes an island.
  const area = (layer, r) => {
    let a = 0
    for (let p = layer.ringStart[r]; p < layer.ringStart[r + 1]; p++) {
      const q = p + 1 < layer.ringStart[r + 1] ? p + 1 : layer.ringStart[r]
      a += layer.coordinates[p * 2] * layer.coordinates[q * 2 + 1]
         - layer.coordinates[q * 2] * layer.coordinates[p * 2 + 1]
    }
    return a / 2
  }

  let holes = 0
  for (const name of ["land", "land-lo", "lakes", "urban"]) {
    const layer = shipped.layers[name]
    for (let f = 0; f < layer.featureCount; f++) {
      const first = layer.featureRing[f]
      const outer = area(layer, first)
      if (outer === 0) continue
      for (let r = first + 1; r < layer.featureRing[f + 1]; r++) {
        const inner = area(layer, r)
        // A ring larger than the first is another exterior, not a hole.
        if (inner === 0 || Math.abs(inner) > Math.abs(outer)) continue
        holes++
        assert.notStrictEqual(Math.sign(inner), Math.sign(outer),
          `${name} feature ${f} ring ${r} is wound the same way as its exterior`)
      }
    }
  }
  assert.ok(holes > 400, `expected the basemap to carry holes at all, found ${holes}`)
})

test("the shipped basemap carries every layer the renderer draws", () => {
  // The renderer names these; a rebuild that dropped one would leave the map
  // quietly missing its coastlines.
  for (const name of ["land-lo", "land", "lakes", "urban", "rivers", "admin1", "admin0", "places"]) {
    assert.ok(shipped.layers[name], `missing layer: ${name}`)
    assert.ok(shipped.layers[name].featureCount > 0, `empty layer: ${name}`)
  }
})

test("every zoom the map can reach is covered by a ground layer", () => {
  // Without this a zoom level renders as bare sea, which reads as a fault.
  for (let zoom = 3; zoom <= 9; zoom++) {
    const ground = ["land-lo", "land"].filter(
      name => Basemap.layerAppliesAt(shipped.layers[name], zoom))
    assert.strictEqual(ground.length, 1,
      `z${zoom} is drawn by ${ground.length} land layers: ${ground.join(", ")}`)
  }
})

test("every coordinate in the shipped basemap is on the globe", () => {
  for (const name of shipped.order) {
    const layer = shipped.layers[name]
    if (!layer.coordinates) continue
    for (let i = 0; i < layer.coordinates.length; i += 2) {
      const longitude = layer.coordinates[i] / QUANTUM
      const latitude = layer.coordinates[i + 1] / QUANTUM
      if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) {
        assert.fail(`${name} has a point at ${latitude}, ${longitude}`)
      }
    }
  }
})

test("the shipped place names kept their accents", () => {
  const byName = {}
  for (const place of shipped.layers.places.places) byName[place.name] = place
  // Two-byte and three-byte sequences both, since the decoder spells UTF-8 out
  // by hand and the two paths through it are different code.
  for (const name of ["São Paulo", "Malmö", "Zürich", "Culiacán"]) {
    assert.ok(byName[name], `${name} is missing or mis-decoded`)
  }
  for (const name of ["Việt Trì", "Ṭarābulus"]) {
    assert.ok(byName[name], `${name} is missing or mis-decoded`)
  }

  // Natural Earth's primary name is the local one in many places and the
  // English exonym in others; the map shows what the data says. Cologne is the
  // documented cost of shipping one name per place.
  assert.ok(byName["Cologne"] && !byName["Köln"])
  assert.ok(byName["København"], "and Copenhagen is stored the way it is written there")
})

test("a known city sits where it should on the globe", () => {
  const oslo = shipped.layers.places.places.find(place => place.name === "Oslo")
  assert.ok(oslo, "Oslo is missing")
  assert.ok(TileMath.haversineKm(oslo.latitude, oslo.longitude, 59.913, 10.752) < 5,
    `Oslo decoded to ${oslo.latitude}, ${oslo.longitude}`)
})

test("drawing a busy view stays within a frame's worth of work", () => {
  // The map repaints on every step of a drag. This is not a benchmark so much
  // as a guard: a change that made the renderer walk the whole world again
  // would show up here rather than as a map that stutters when panned.
  const where = view(6, 51.5, 10)
  let points = 0
  for (const name of shipped.order) {
    const layer = shipped.layers[name]
    if (!Basemap.layerAppliesAt(layer, where.zoom) || layer.kind === 2) continue
    for (const index of Basemap.featuresInBounds(layer, Basemap.viewBounds(where))) {
      for (const path of Basemap.featurePaths(layer, index, where)) points += path.length / 2
    }
  }
  assert.ok(points < 30000, `a single frame would draw ${points} points`)
})

// ---------------------------------------------------------------------------
// The antimeridian
// ---------------------------------------------------------------------------

test("a viewport inside one copy of the world asks for one copy", () => {
  assert.deepStrictEqual(Basemap.worldOffsets({ west: -50, east: -40 }), [0])
  assert.deepStrictEqual(Basemap.worldOffsets({ west: 110, east: 129 }), [0])
})

test("a viewport straddling the antimeridian asks for both copies", () => {
  assert.deepStrictEqual(Basemap.worldOffsets({ west: 170, east: 190 }), [0, 1])
  assert.deepStrictEqual(Basemap.worldOffsets({ west: -190, east: -170 }), [-1, 0])
})

test("a viewport panned right past the antimeridian asks for the next copy", () => {
  assert.deepStrictEqual(Basemap.worldOffsets({ west: 190, east: 209 }), [1])
  assert.deepStrictEqual(Basemap.worldOffsets({ west: 550, east: 560 }), [2])
})

test("shifting a window by its offset lands it back on the stored world", () => {
  const window = { west: 190, east: 209, south: 30, north: 40 }
  const shifted = Basemap.shiftWindow(window, 1)
  assert.deepStrictEqual(shifted, { west: -170, east: -151, south: 30, north: 40 })
  assert.strictEqual(Basemap.shiftView(view(6, 35, 200), 1).centerLongitude, -160)
  assert.strictEqual(Basemap.shiftView(view(6, 35, 200), 1).centerLatitude, 35,
    "latitude does not wrap; there is nothing above the pole")
})

test("panning past the antimeridian keeps finding ground", () => {
  // Regression: the ground was stored once at real longitudes while the radar
  // tiles wrapped on their own, so panning east from Asia left the radar drawn
  // over open sea with nothing under it.
  const land = shipped.layers["land"]
  const found = longitude => {
    const where = view(6, 35, longitude)
    const window = Basemap.viewBounds(where)
    return Basemap.worldOffsets(window).reduce(
      (total, offset) => total + Basemap.featuresInBounds(land, Basemap.shiftWindow(window, offset)).length, 0)
  }

  // 240 degrees east is 120 west: the western United States, which is land.
  assert.ok(found(240) > 0, "the Americas are still there once round")
  assert.strictEqual(found(240), found(-120), "and they are the same land either way")
  assert.strictEqual(found(480), found(120), "twice round, likewise")
})

test("a place near the antimeridian is labelled from the other side of it", () => {
  const layer = Basemap.decode(encode([
    { name: "places", kind: 2, minZoom: 3, maxZoom: 9, places: [
      { x: 179500, y: -16900, minZoom: 3, name: "Suva" }
    ] }
  ])).layers.places

  // A map centred just east of the line. Suva is a degree away on the globe.
  const shown = Basemap.placesInView(layer, view(7, -16.9, -179.8), {})
  assert.deepStrictEqual(shown.map(place => place.name), ["Suva"])
  assert.ok(shown[0].x > 0 && shown[0].x < 700, `drawn off the canvas at x=${shown[0].x}`)
})

test("the same view yields the same ground however far it has been panned", () => {
  // Whether the centre is stored as 120 or as 480 must not change the picture.
  const land = shipped.layers["land"]
  const trace = longitude => {
    const where = view(6, 35, longitude)
    const window = Basemap.viewBounds(where)
    const points = []
    for (const offset of Basemap.worldOffsets(window)) {
      const copyView = Basemap.shiftView(where, offset)
      for (const index of Basemap.featuresInBounds(land, Basemap.shiftWindow(window, offset))) {
        for (const path of Basemap.featurePaths(land, index, copyView)) points.push(...path)
      }
    }
    return points
  }

  const near = trace(120)
  const round = trace(480)
  assert.strictEqual(near.length, round.length, "a different number of points")
  for (let i = 0; i < near.length; i++) {
    assert.ok(Math.abs(near[i] - round[i]) < 1e-6, `point ${i} moved by ${near[i] - round[i]}`)
  }
})

// ---------------------------------------------------------------------------
// Filling a shape the viewport sits inside
// ---------------------------------------------------------------------------

function pointInPath(path, x, y) {
  // Ray casting. `path` is the flat [x, y, x, y, ...] a fill would trace.
  let inside = false
  const count = path.length / 2
  for (let i = 0, j = count - 1; i < count; j = i++) {
    const xi = path[i * 2], yi = path[i * 2 + 1]
    const xj = path[j * 2], yj = path[j * 2 + 1]
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

test("a shape the viewport sits well inside still encloses it", () => {
  // Regression, and the one that matters most: a continent seen from deep
  // inland has every point of its coastline off-screen. Folding those points
  // into runs is what keeps the renderer cheap, but a run may only be folded
  // while all of it stays outside one edge. Comparing each point against only
  // the one before it lets the shared edge drift around a corner, and the
  // outline then collapses to a wedge — which fills a diagonal band across the
  // map and leaves the rest showing the sea colour underneath.
  const ring = []
  const R = 40000   // 40 degrees, in quantised units
  const steps = 200
  for (let i = 0; i < steps; i++) ring.push([R, -R + Math.round(2 * R * i / steps)])       // east
  for (let i = 0; i < steps; i++) ring.push([R - Math.round(2 * R * i / steps), R])        // north
  for (let i = 0; i < steps; i++) ring.push([-R, R - Math.round(2 * R * i / steps)])       // west
  for (let i = 0; i < steps; i++) ring.push([-R + Math.round(2 * R * i / steps), -R])      // south
  ring.push(ring[0])

  const layer = Basemap.decode(encode([
    { name: "continent", kind: 1, minZoom: 3, maxZoom: 9, features: [[ring]] }
  ])).layers.continent

  for (const zoom of [6, 7, 8, 9]) {
    const where = view(zoom, 0, 0)
    const paths = Basemap.featurePaths(layer, 0, where)
    assert.strictEqual(paths.length, 1, `z${zoom}: expected one ring`)

    for (const [x, y] of [[where.width / 2, where.height / 2], [1, 1],
                          [where.width - 1, 1], [1, where.height - 1],
                          [where.width - 1, where.height - 1]]) {
      assert.ok(pointInPath(paths[0], x, y),
        `z${zoom}: (${x}, ${y}) fell outside a shape that surrounds the whole view`)
    }
  }
})

test("the shipped land still covers a view taken from inland", () => {
  // The view from the report: southern Brazil, well inside the continent.
  const where = view(6, -26.15, -53.03)
  const land = shipped.layers["land"]
  const window = Basemap.viewBounds(where)

  let covered = false
  for (const offset of Basemap.worldOffsets(window)) {
    const copyView = Basemap.shiftView(where, offset)
    for (const index of Basemap.featuresInBounds(land, Basemap.shiftWindow(window, offset))) {
      for (const path of Basemap.featurePaths(land, index, copyView)) {
        if (pointInPath(path, where.width / 2, where.height / 2)) covered = true
      }
    }
  }
  assert.ok(covered, "the middle of the map is sea, in the middle of a continent")
})

test("a point is not folded away when it turns the path around", () => {
  // Regression, from Antarctica. Natural Earth closes a polygon that wraps the
  // pole by running down the antimeridian, across the bottom of the world and
  // up the other side, so two consecutive points sit at opposite corners — one
  // outside the right edge, one outside the left. Both are outside, and the
  // second shares an edge with the third, but folding it away leaves an edge
  // running from the far right to the far left: a line straight across the map.
  const ring = [[179400, -84206], [180000, -84352], [180000, -89999], [-180000, -89999],
                [-180000, -84352], [-179400, -84206]]
  // A plausible coast back along 80 south, rather than one giant hop, so the
  // fixture cannot fail on a shortcut it wrote itself.
  for (let lon = -179000; lon <= 179000; lon += 2000) ring.push([lon, -80000])
  ring.push([179400, -84206])

  const layer = Basemap.decode(encode([
    { name: "antarctica", kind: 1, minZoom: 3, maxZoom: 9, features: [[ring]] }
  ])).layers.antarctica

  for (const zoom of [3, 4, 5]) {
    const where = view(zoom, TileMath.constrainLatitude(-89.9, zoom, 320), 0)
    // The outline: what gets stroked as coastline.
    for (const path of Basemap.featurePaths(layer, 0, where, undefined, true)) {
      for (let i = 0; i + 3 < path.length; i += 2) {
        assert.ok(!crossesInterior(path[i], path[i + 1], path[i + 2], path[i + 3], where),
          `z${zoom}: a coastline runs across the map from ` +
          `[${Math.round(path[i])},${Math.round(path[i + 1])}] to ` +
          `[${Math.round(path[i + 2])},${Math.round(path[i + 3])}]`)
      }
    }
  }
})

test("the edge that closes a polygon at the pole is not drawn as coastline", () => {
  // It has to exist for the fill — the shape would not be closed without it —
  // and it must not be stroked, or panning to the antimeridian at the southern
  // limit puts a line down the middle of the map.
  const ring = [[180000, -84352], [180000, -89999], [-180000, -89999], [-180000, -84352],
                [0, -84000], [180000, -84352]]
  const layer = Basemap.decode(encode([
    { name: "antarctica", kind: 1, minZoom: 3, maxZoom: 9, features: [[ring]] }
  ])).layers.antarctica

  const where = view(5, TileMath.constrainLatitude(-89.9, 5, 320), 180)
  const filled = Basemap.featurePaths(layer, 0, where, undefined, false)
  const outlined = Basemap.featurePaths(layer, 0, where, undefined, true)

  assert.strictEqual(filled.length, 1, "the fill keeps the ring whole")
  assert.ok(outlined.length >= 1, "the outline is what is left once the cut is removed")
  const filledPoints = filled.reduce((n, p) => n + p.length, 0)
  const outlinedPoints = outlined.reduce((n, p) => n + p.length, 0)
  assert.ok(outlinedPoints < filledPoints,
    `the outline should drop the closing edges: ${outlinedPoints} vs ${filledPoints}`)
})

// Does a segment pass through the middle of the viewport? The two-pixel inset
// leaves out the world's own bottom edge, which legitimately runs along the
// very bottom of the map at the southern limit.
function crossesInterior(x1, y1, x2, y2, where) {
  const left = 2, right = where.width - 2, top = 2, bottom = where.height - 2
  const outcode = (x, y) =>
    (x < left ? 1 : 0) | (x > right ? 2 : 0) | (y < top ? 4 : 0) | (y > bottom ? 8 : 0)
  if (outcode(x1, y1) & outcode(x2, y2)) return false
  if (Math.hypot(x2 - x1, y2 - y1) < 400) return false
  for (let t = 0; t <= 1; t += 0.005) {
    const x = x1 + (x2 - x1) * t
    const y = y1 + (y2 - y1) * t
    if (x >= left && x <= right && y >= top && y <= bottom) return true
  }
  return false
}

test("the shipped ground draws no shortcut across the poles", () => {
  // The same check against the real data, at the limit the map can reach.
  for (const zoom of [3, 5, 7, 9]) {
    for (const latitude of [TileMath.constrainLatitude(-89.9, zoom, 320),
                            TileMath.constrainLatitude(89.9, zoom, 320)]) {
      for (const longitude of [-180, -90, 0, 90, 170]) {
        const where = view(zoom, latitude, longitude)
        const window = Basemap.viewBounds(where)

        for (const name of ["land-lo", "land", "lakes", "urban", "rivers"]) {
          const layer = shipped.layers[name]
          if (!Basemap.layerAppliesAt(layer, zoom)) continue
          for (const offset of Basemap.worldOffsets(window)) {
            const copyView = Basemap.shiftView(where, offset)
            for (const index of Basemap.featuresInBounds(layer, Basemap.shiftWindow(window, offset))) {
              for (const path of Basemap.featurePaths(layer, index, copyView, undefined, true)) {
                for (let i = 0; i + 3 < path.length; i += 2) {
                  assert.ok(!crossesInterior(path[i], path[i + 1], path[i + 2], path[i + 3], where),
                    `${name} at z${zoom}, ${latitude.toFixed(1)}, ${longitude}: ` +
                    `[${Math.round(path[i])},${Math.round(path[i + 1])}] -> ` +
                    `[${Math.round(path[i + 2])},${Math.round(path[i + 3])}]`)
                }
              }
            }
          }
        }
      }
    }
  }
})

test("only the shapes cut open by the projection are traced twice", () => {
  // The renderer strokes from the fill's own path unless a feature can contain
  // a closing edge, so this predicate is what keeps the common case at one
  // traversal per feature.
  const land = shipped.layers["land"]
  let touching = 0
  for (let index = 0; index < land.featureCount; index++) {
    if (Basemap.featureTouchesDomainEdge(land, index)) touching++
  }
  assert.ok(touching > 0, "Antarctica reaches the pole and the antimeridian")
  assert.ok(touching < land.featureCount * 0.02,
    `${touching} of ${land.featureCount} land features claim to touch the domain edge`)

  assert.strictEqual(Basemap.featureTouchesDomainEdge(null, 0), false)
  assert.strictEqual(Basemap.featureTouchesDomainEdge(land, -1), false)
  assert.strictEqual(Basemap.featureTouchesDomainEdge(land, land.featureCount), false)
})
