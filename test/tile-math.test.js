const { test } = require("node:test")
const assert = require("node:assert")
const { TileMath } = require("./load.js")

// Reference distances and bearings are computed with the spherical law of
// cosines rather than with a haversine, so a mistake in the formula under test
// cannot be reproduced by the expectation.
const KM = 0.5   // tolerance, in kilometres, for a great-circle figure

function close(actual, expected, tolerance, message) {
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${message}: expected ${expected} +/- ${tolerance}, got ${actual}`)
}

// ------------------------------------------------------------------ projection

test("longitude and tile X round-trip at every zoom the map uses", () => {
  for (let zoom = 3; zoom <= 10; zoom++) {
    for (const lon of [-180, -46.6333, -0.0001, 0, 12.5, 179.9]) {
      const back = TileMath.tileXToLon(TileMath.lonToTileX(lon, zoom), zoom)
      close(back, lon, 1e-9, `lon ${lon} at z${zoom}`)
    }
  }
})

test("latitude and tile Y round-trip inside the projection's range", () => {
  for (let zoom = 3; zoom <= 10; zoom++) {
    for (const lat of [-85, -23.5505, -0.0001, 0, 51.5074, 85]) {
      const back = TileMath.tileYToLat(TileMath.latToTileY(lat, zoom), zoom)
      close(back, lat, 1e-6, `lat ${lat} at z${zoom}`)
    }
  }
})

test("the projection's poles are clamped rather than allowed to diverge", () => {
  // tan(90 degrees) is infinite; an unclamped implementation returns Infinity
  // here and every tile computed from it is NaN.
  for (const lat of [90, -90, 89.9, 1e6]) {
    const y = TileMath.latToTileY(lat, 7)
    assert.ok(Number.isFinite(y), `latToTileY(${lat}) must be finite, got ${y}`)
  }
  assert.strictEqual(TileMath.clampLatitude(90), 85.0511287798)
  assert.strictEqual(TileMath.clampLatitude(-90), -85.0511287798)
  assert.strictEqual(TileMath.clampLatitude(10), 10)
})

test("zoom 0 is one tile and the world centre sits in the middle of it", () => {
  close(TileMath.lonToTileX(0, 0), 0.5, 1e-12, "centre X")
  close(TileMath.latToTileY(0, 0), 0.5, 1e-12, "centre Y")
  close(TileMath.lonToTileX(-180, 0), 0, 1e-12, "west edge")
  close(TileMath.lonToTileX(180, 0), 1, 1e-12, "east edge")
})

// ------------------------------------------------------------------ resolution

test("ground resolution matches the published Web Mercator figures", () => {
  close(TileMath.metersPerPixel(0, 0), 156543.03392804097, 1e-6, "z0 at the equator")
  close(TileMath.metersPerPixel(0, 7), 156543.03392804097 / 128, 1e-9, "z7 at the equator")
  // Mercator stretches away from the equator, so a pixel covers less ground.
  close(TileMath.metersPerPixel(-23.55, 7), 1121.1315526873184, 1e-6, "z7 at 23.55S")
})

test("kilometres and pixels round-trip through the same latitude and zoom", () => {
  for (const lat of [0, -23.55, 60]) {
    for (const zoom of [3, 7, 9]) {
      const pixels = TileMath.kmToPixels(100, lat, zoom)
      close(TileMath.pixelsToKm(pixels, lat, zoom), 100, 1e-9, `100 km at ${lat} z${zoom}`)
    }
  }
})

// ------------------------------------------------------------------ distance

test("great-circle distance matches independently computed references", () => {
  close(TileMath.haversineKm(-23.5505, -46.6333, -22.9068, -43.1729), 360.7493, KM, "Sao Paulo to Rio")
  close(TileMath.haversineKm(51.5074, -0.1278, 48.8566, 2.3522), 343.5565, KM, "London to Paris")
  close(TileMath.haversineKm(0, 0, 0, 1), 111.1951, KM, "one degree of longitude at the equator")
  close(TileMath.haversineKm(0, 0, 90, 0), 10007.5572, KM, "equator to pole")
  assert.strictEqual(TileMath.haversineKm(10, 20, 10, 20), 0, "a point is zero from itself")
})

test("bearing and compass point agree with the reference bearings", () => {
  close(TileMath.bearingDegrees(-23.5505, -46.6333, -22.9068, -43.1729), 79.242, 0.01, "Sao Paulo to Rio")
  close(TileMath.bearingDegrees(0, 0, 0, 1), 90, 1e-9, "due east")
  close(TileMath.bearingDegrees(0, 0, 1, 0), 0, 1e-9, "due north")

  assert.strictEqual(TileMath.compassPoint(0), "N")
  assert.strictEqual(TileMath.compassPoint(90), "E")
  assert.strictEqual(TileMath.compassPoint(180), "S")
  assert.strictEqual(TileMath.compassPoint(270), "W")
  assert.strictEqual(TileMath.compassPoint(359), "N", "wraps back to north")
  assert.strictEqual(TileMath.compassPoint(-90), "W", "a negative bearing is normalised")
  assert.strictEqual(TileMath.compassPoint(405), "NE", "a bearing over 360 is normalised")
})

// ------------------------------------------------------------------ viewport

test("a viewport is centred on the coordinate it was asked for", () => {
  const width = 700
  const height = 400
  const view = TileMath.viewportTiles(-23.5505, -46.6333, 7, width, height)

  // Where the centre coordinate lands once the tile grid is laid out. It has
  // to be the middle of the viewport, or the map is centred on nothing.
  const x = view.originX + (view.centerX - view.minX) * 256
  const y = view.originY + (view.centerY - view.minY) * 256
  close(x, width / 2, 1e-9, "centre X")
  close(y, height / 2, 1e-9, "centre Y")
})

test("a viewport covers itself completely", () => {
  const width = 700
  const height = 400
  const view = TileMath.viewportTiles(51.5074, -0.1278, 9, width, height)

  assert.ok(view.originX <= 0, "the first tile starts at or before the left edge")
  assert.ok(view.originY <= 0, "the first tile starts at or above the top edge")
  const spanX = view.originX + (view.maxX - view.minX + 1) * 256
  const spanY = view.originY + (view.maxY - view.minY + 1) * 256
  assert.ok(spanX >= width, `tiles span ${spanX}px, viewport is ${width}px wide`)
  assert.ok(spanY >= height, `tiles span ${spanY}px, viewport is ${height}px tall`)
})

test("projecting a coordinate into the viewport and back returns it", () => {
  const width = 700
  const height = 400
  const centreLat = -23.5505
  const centreLon = -46.6333

  for (const [lat, lon] of [[-23.5505, -46.6333], [-22.9068, -43.1729], [-24.1, -47.9]]) {
    const point = TileMath.projectToViewport(lat, lon, centreLat, centreLon, 7, width, height)
    const back = TileMath.unprojectFromViewport(point.x, point.y, centreLat, centreLon, 7, width, height)
    close(back.latitude, lat, 1e-9, "latitude")
    close(back.longitude, lon, 1e-9, "longitude")
  }
})

test("the centre coordinate projects to the middle of the viewport", () => {
  const point = TileMath.projectToViewport(-23.5505, -46.6333, -23.5505, -46.6333, 7, 700, 400)
  close(point.x, 350, 1e-9, "centre X")
  close(point.y, 200, 1e-9, "centre Y")
})

// ------------------------------------------------------------------ wrapping

test("tile X wraps around the world and tile Y does not", () => {
  // The world repeats east-west, so panning past the antimeridian has to land
  // back on real tiles rather than request a negative index.
  assert.strictEqual(TileMath.wrapTileX(-1, 3), 7)
  assert.strictEqual(TileMath.wrapTileX(8, 3), 0)
  assert.strictEqual(TileMath.wrapTileX(9, 3), 1)
  assert.strictEqual(TileMath.wrapTileX(3, 3), 3)

  // There is nothing above the pole, so those rows are simply absent.
  assert.strictEqual(TileMath.isValidTileY(-1, 3), false)
  assert.strictEqual(TileMath.isValidTileY(0, 3), true)
  assert.strictEqual(TileMath.isValidTileY(7, 3), true)
  assert.strictEqual(TileMath.isValidTileY(8, 3), false)
})
