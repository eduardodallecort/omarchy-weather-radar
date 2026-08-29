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

// ------------------------------------------------------------------ the seam

test("longitude normalises onto the globe from anywhere", () => {
  close(TileMath.wrapLongitude(0), 0, 1e-9, "prime meridian")
  close(TileMath.wrapLongitude(120), 120, 1e-9, "unchanged inside the range")
  close(TileMath.wrapLongitude(-120), -120, 1e-9, "unchanged inside the range")
  close(TileMath.wrapLongitude(181), -179, 1e-9, "just past the antimeridian")
  close(TileMath.wrapLongitude(200), -160, 1e-9, "panned east")
  close(TileMath.wrapLongitude(-190), 170, 1e-9, "panned west")
  close(TileMath.wrapLongitude(360), 0, 1e-9, "once round")
  close(TileMath.wrapLongitude(-720), 0, 1e-9, "twice round the other way")
  close(TileMath.wrapLongitude(180), -180, 1e-9, "the antimeridian belongs to the west")
})

test("the nearest copy of a longitude is never more than half a world away", () => {
  // Two points either side of the antimeridian are a couple of degrees apart
  // on the globe and 358 apart in their coordinates. Anything positioned by
  // subtracting one from the other has to ask for the near copy.
  close(TileMath.nearestLongitude(179, -179), -181, 1e-9, "east of the line, seen from the west")
  close(TileMath.nearestLongitude(-179, 179), 181, 1e-9, "west of the line, seen from the east")
  close(TileMath.nearestLongitude(10, 0), 10, 1e-9, "nothing to do in the ordinary case")
  close(TileMath.nearestLongitude(-46.6, -46.6), -46.6, 1e-9, "a point is nearest to itself")

  for (const reference of [-179, 0, 45, 179, 200, -540]) {
    for (const longitude of [-180, -90, 0, 90, 179.9]) {
      const near = TileMath.nearestLongitude(longitude, reference)
      assert.ok(Math.abs(near - reference) <= 180 + 1e-9,
        `${longitude} from ${reference} landed ${Math.abs(near - reference)} away`)
      close(TileMath.wrapLongitude(near), TileMath.wrapLongitude(longitude), 1e-9,
        "and it is still the same place")
    }
  }
})

// ------------------------------------------------------------------ anchoring

test("a coordinate stays under the pixel it was anchored to", () => {
  const width = 700
  const height = 320

  for (const zoom of [3, 5, 7, 9]) {
    for (const [x, y] of [[0, 0], [350, 160], [699, 319], [120, 40]]) {
      const centre = TileMath.centerForPoint(-23.5505, -46.6333, x, y, zoom, width, height)
      const back = TileMath.projectToViewport(
        -23.5505, -46.6333, centre.latitude, centre.longitude, zoom, width, height)
      close(back.x, x, 1e-6, `x at z${zoom}`)
      close(back.y, y, 1e-6, `y at z${zoom}`)
    }
  }
})

test("anchoring to the middle of the viewport centres on the coordinate", () => {
  const centre = TileMath.centerForPoint(51.5074, -0.1278, 350, 160, 7, 700, 320)
  close(centre.latitude, 51.5074, 1e-9, "latitude")
  close(centre.longitude, -0.1278, 1e-9, "longitude")
})

test("zooming towards a pixel keeps what was under it under it", () => {
  // The whole point of zooming to the pointer: read the coordinate under the
  // cursor, then re-centre so it does not move.
  const width = 700
  const height = 320
  let latitude = -23.5505
  let longitude = -46.6333
  const cursorX = 120
  const cursorY = 40

  const anchor = TileMath.unprojectFromViewport(
    cursorX, cursorY, latitude, longitude, 6, width, height)

  for (const zoom of [7, 8, 9]) {
    const centre = TileMath.centerForPoint(
      anchor.latitude, anchor.longitude, cursorX, cursorY, zoom, width, height)
    const where = TileMath.projectToViewport(
      anchor.latitude, anchor.longitude, centre.latitude, centre.longitude, zoom, width, height)
    close(where.x, cursorX, 1e-6, `x at z${zoom}`)
    close(where.y, cursorY, 1e-6, `y at z${zoom}`)
  }
})

test("anchoring near a pole stays on the projection", () => {
  // Mercator has no room above 85 degrees, so the centre is clamped and the
  // anchor slides — but the map must not be asked to render a latitude that
  // does not exist.
  const centre = TileMath.centerForPoint(84.9, 0, 350, 319, 5, 700, 320)
  assert.ok(Math.abs(centre.latitude) <= 85.0511287798, `latitude ${centre.latitude}`)
  assert.ok(Number.isFinite(centre.longitude))
})

// ------------------------------------------------------------------ alignment

test("the tile grid and the direct projection agree on where a coordinate is", () => {
  // The ground is drawn by projecting each point, the radar by laying out a
  // grid of tile images. Two different paths through this file, and the whole
  // layered design rests on them landing on the same pixel: any drift shows up
  // as rain sitting next to the coastline instead of on it, which nothing
  // reports and only an eye catches.
  const width = 700
  const height = 320
  const TILE = 256

  for (const zoom of [3, 5, 7, 9]) {
    for (const [centreLat, centreLon] of [[0, 0], [-23.5505, -46.6333], [51.5074, -0.1278], [-45, 170]]) {
      const view = TileMath.viewportTiles(centreLat, centreLon, zoom, width, height)

      for (const [lat, lon] of [[centreLat, centreLon], [centreLat + 1, centreLon + 1],
                                [centreLat - 0.7, centreLon + 2.3]]) {
        // How TileLayer places it: the tile grid's origin, plus the offset of
        // the coordinate inside that grid.
        const grid = {
          x: view.originX + (TileMath.lonToTileX(lon, zoom) - view.minX) * TILE,
          y: view.originY + (TileMath.latToTileY(lat, zoom) - view.minY) * TILE
        }
        // How BasemapLayer places it: straight from the centre.
        const direct = TileMath.projectToViewport(
          lat, lon, centreLat, centreLon, zoom, width, height)

        close(grid.x, direct.x, 1e-6, `x at z${zoom} from ${centreLat},${centreLon}`)
        close(grid.y, direct.y, 1e-6, `y at z${zoom} from ${centreLat},${centreLon}`)
      }
    }
  }
})

test("a layer drawn below its own zoom lands where the full-resolution one would", () => {
  // The radar's tiles stop at z7 and are scaled up past it, while the ground
  // keeps sharpening. The upscaled grid has to cover exactly the same ground,
  // or the rain drifts off the coast as you zoom in.
  const width = 700
  const height = 320
  const TILE = 256

  for (const zoom of [8, 9]) {
    const sourceZoom = 7
    const scale = Math.pow(2, zoom - sourceZoom)
    const centreLat = -23.5505
    const centreLon = -46.6333

    // TileLayer lays the grid out in source-zoom space over a viewport shrunk
    // by the scale, then scales the result onto the screen.
    const view = TileMath.viewportTiles(
      centreLat, centreLon, sourceZoom, width / scale, height / scale)

    for (const [lat, lon] of [[centreLat, centreLon], [centreLat + 0.3, centreLon - 0.4]]) {
      const scaled = {
        x: (view.originX + (TileMath.lonToTileX(lon, sourceZoom) - view.minX) * TILE) * scale,
        y: (view.originY + (TileMath.latToTileY(lat, sourceZoom) - view.minY) * TILE) * scale
      }
      const direct = TileMath.projectToViewport(
        lat, lon, centreLat, centreLon, zoom, width, height)

      close(scaled.x, direct.x, 1e-6, `x at z${zoom} over z${sourceZoom} tiles`)
      close(scaled.y, direct.y, 1e-6, `y at z${zoom} over z${sourceZoom} tiles`)
    }
  }
})

// ------------------------------------------------------------------ the poles

test("the viewport is kept inside the projection", () => {
  // Regression: panning south of Antarctica put the world's bottom edge across
  // the middle of the panel, with nothing under it and the map unresponsive.
  const height = 320

  for (const zoom of [4, 6, 9]) {
    const world = Math.pow(2, zoom)
    const halfTiles = (height / 2) / 256

    for (const wanted of [-89.9, -86, -85.0511287798, -85, -60, 0, 60, 85, 86, 89.9]) {
      const centre = TileMath.constrainLatitude(wanted, zoom, height)
      const y = TileMath.latToTileY(centre, zoom)
      assert.ok(y - halfTiles >= -1e-9, `z${zoom} from ${wanted}: top edge left the world`)
      assert.ok(y + halfTiles <= world + 1e-9, `z${zoom} from ${wanted}: bottom edge left the world`)
    }
  }
})

test("a latitude already inside the limits is left alone", () => {
  for (const zoom of [4, 6, 9]) {
    for (const lat of [-60, -23.5505, 0, 51.5074]) {
      close(TileMath.constrainLatitude(lat, zoom, 320), lat, 1e-9, `z${zoom} at ${lat}`)
    }
  }
})

test("the constraint tightens as the map zooms out", () => {
  // The same panel covers more of the globe at a lower zoom, so a centre that
  // was legal deep in stops being legal — which is why zooming has to reapply
  // this and not only dragging.
  const height = 320
  const deep = TileMath.constrainLatitude(-89, 9, height)
  const shallow = TileMath.constrainLatitude(-89, 4, height)
  assert.ok(deep < shallow, `z9 allows ${deep}, z4 allows ${shallow}`)
  assert.ok(shallow > -85.0511287798)
})

test("a panel taller than the world centres on the equator", () => {
  // There is no valid centre when the whole globe is shorter than the viewport;
  // the alternative is an arbitrary one that leaves a gap at top or bottom.
  assert.strictEqual(TileMath.constrainLatitude(-80, 0, 320), 0)
  assert.strictEqual(TileMath.constrainLatitude(40, 1, 900), 0)
})

test("constraining is symmetric between the poles", () => {
  for (const zoom of [4, 6, 9]) {
    const south = TileMath.constrainLatitude(-89.9, zoom, 320)
    const north = TileMath.constrainLatitude(89.9, zoom, 320)
    close(south, -north, 1e-9, `z${zoom}`)
  }
})
