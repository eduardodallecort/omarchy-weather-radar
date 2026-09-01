const { test } = require("node:test")
const assert = require("node:assert")
const { RadarModel } = require("./load.js")

// ------------------------------------------------------------------ constants

test("the zoom limits describe a usable range", () => {
  assert.ok(RadarModel.MIN_RADAR_ZOOM < RadarModel.MAX_RADAR_ZOOM)
  assert.ok(RadarModel.MAX_RADAR_ZOOM <= RadarModel.MAX_MAP_ZOOM,
    "the map may go deeper than the radar, never shallower")
})

test("polling never runs faster than the provider publishes", () => {
  assert.strictEqual(RadarModel.FRAME_INTERVAL_SEC, 600)
})

test("every offered colour scheme is one the API knows", () => {
  for (const scheme of RadarModel.COLOR_SCHEMES) {
    assert.strictEqual(RadarModel.isKnownColorScheme(scheme.id), true, scheme.name)
    assert.strictEqual(RadarModel.colorSchemeName(scheme.id), scheme.name)
  }
  assert.strictEqual(RadarModel.isKnownColorScheme(99), false)
  assert.strictEqual(RadarModel.colorSchemeName(99), "Unknown")
})

// ------------------------------------------------------------------ tile URLs

test("a radar tile URL carries every parameter in the documented order", () => {
  const url = RadarModel.tileUrl("https://tilecache.rainviewer.com", "/v2/radar/1788009624",
    256, 7, 42, 65, 2, true, false)
  assert.strictEqual(url,
    "https://tilecache.rainviewer.com/v2/radar/1788009624/256/7/42/65/2/1_0.png")
})

test("a tile URL is empty when there is nothing to request yet", () => {
  // An empty source keeps the tile blank instead of firing a request at a
  // half-built URL while the manifest is still in flight.
  assert.strictEqual(RadarModel.tileUrl("", "/v2/radar/1", 256, 7, 1, 1, 2, true, true), "")
  assert.strictEqual(RadarModel.tileUrl("https://host", "", 256, 7, 1, 1, 2, true, true), "")
  assert.strictEqual(RadarModel.tileUrl(null, null, 256, 7, 1, 1, 2, true, true), "")
})

test("a coordinate-centred URL always spells its coordinates with a decimal point", () => {
  // The API rejects a bare integer, and a whole-degree location is exactly
  // where String(Number(x)) drops the point.
  const url = RadarModel.centeredTileUrl("https://h", "/p", 512, 7, -23, 46, 0, false, false)
  assert.ok(url.includes("/-23.0/46.0/"), url)

  const fractional = RadarModel.centeredTileUrl("https://h", "/p", 512, 7, -23.5505, -46.6333, 0, false, false)
  assert.ok(fractional.includes("/-23.5505/-46.6333/"), fractional)
})

test("the coverage mask is requested from the host alone", () => {
  assert.strictEqual(
    RadarModel.coverageTileUrl("https://h", 512, 7, -23, -46),
    "https://h/v2/coverage/0/512/7/-23.0/-46.0/0/0_0.png")
  assert.strictEqual(RadarModel.coverageTileUrl("", 512, 7, 0, 0), "")
})

test("a geocoding query is escaped rather than pasted into the URL", () => {
  const url = RadarModel.geocodingUrl("São Paulo", 5)
  assert.ok(url.includes("name=S%C3%A3o%20Paulo"), url)
  assert.ok(!url.includes(" "), "a raw space would break the request")
  assert.ok(RadarModel.geocodingUrl("x").includes("count=5"), "the count has a default")
})

// ------------------------------------------------------------------ manifest

const MANIFEST = JSON.stringify({
  version: "2.0",
  generated: 1788009624,
  host: "https://tilecache.rainviewer.com",
  radar: {
    past: [
      { time: 1788009000, path: "/v2/radar/1788009000" },
      { time: 1788008400, path: "/v2/radar/1788008400" }
    ],
    nowcast: [{ time: 1788010200, path: "/v2/radar/nowcast_1788010200" }]
  }
})

test("a manifest parses into frames ordered oldest first", () => {
  const parsed = RadarModel.parseManifest(MANIFEST)
  assert.strictEqual(parsed.host, "https://tilecache.rainviewer.com")
  assert.strictEqual(parsed.generated, 1788009624)
  assert.deepStrictEqual(parsed.past.map(f => f.time), [1788008400, 1788009000])
  assert.strictEqual(parsed.frames.length, 3, "past and nowcast are concatenated")
  assert.strictEqual(RadarModel.latestFrame(parsed).time, 1788009000)
})

test("an unusable manifest is rejected rather than half-accepted", () => {
  // Every one of these is an ordinary response on a laptop: no network, a
  // captive portal serving HTML, a provider returning an error document. The
  // caller keeps its previous frames, so returning null has to mean null.
  for (const bad of ["", "   ", "not json", "<html>captive portal</html>", "null", "{}",
                     JSON.stringify({ host: "https://h" }),
                     JSON.stringify({ radar: { past: [] } }),
                     JSON.stringify({ host: 42, radar: { past: [{ time: 1, path: "/p" }] } }),
                     JSON.stringify({ host: "https://h", radar: { past: [] } })]) {
    assert.strictEqual(RadarModel.parseManifest(bad), null, JSON.stringify(bad))
  }
  assert.strictEqual(RadarModel.parseManifest(null), null)
})

test("a frame missing a path or a sane time is dropped, not carried", () => {
  const parsed = RadarModel.parseManifest(JSON.stringify({
    host: "https://h",
    radar: {
      past: [
        { time: 1788009000, path: "/good" },
        { time: 0, path: "/no-time" },
        { time: 1788009100 },
        { path: "/no-time-at-all" },
        { time: "nonsense", path: "/bad-time" },
        null
      ]
    }
  }))
  assert.deepStrictEqual(parsed.past.map(f => f.path), ["/good"])
})

test("a manifest with no nowcast is still a manifest", () => {
  // The public endpoint has been observed serving an empty nowcast, so it is
  // optional throughout.
  const parsed = RadarModel.parseManifest(JSON.stringify({
    host: "https://h", radar: { past: [{ time: 1, path: "/p" }] }
  }))
  assert.deepStrictEqual(parsed.nowcast, [])
  assert.strictEqual(parsed.frames.length, 1)
})

test("latestFrame tolerates being handed something that is not a manifest", () => {
  assert.strictEqual(RadarModel.latestFrame(null), null)
  assert.strictEqual(RadarModel.latestFrame({}), null)
  assert.strictEqual(RadarModel.latestFrame({ past: [] }), null)
})

// ------------------------------------------------------------------ location

test("a location file without coordinates is not a location", () => {
  // Regression: Number(null) is 0, so a name-only location once read as
  // 0N 0E and the plugin fetched weather for the Gulf of Guinea.
  for (const raw of [JSON.stringify({ name: "Marmeleiro" }),
                     JSON.stringify({ name: "x", latitude: null, longitude: null }),
                     JSON.stringify({ name: "x", latitude: "", longitude: "" }),
                     JSON.stringify({ name: "x", latitude: "abc", longitude: "def" })]) {
    const parsed = RadarModel.parseLocationFile(raw)
    assert.strictEqual(parsed.valid, false, raw)
    assert.strictEqual(parsed.latitude, null, raw)
    assert.strictEqual(parsed.longitude, null, raw)
  }
})

test("a location outside the coordinate ranges is rejected", () => {
  for (const [lat, lon] of [[91, 0], [-91, 0], [0, 181], [0, -181]]) {
    assert.strictEqual(
      RadarModel.parseLocationFile(JSON.stringify({ name: "x", latitude: lat, longitude: lon })).valid,
      false, `${lat},${lon}`)
  }
})

test("a valid location keeps its name and its coordinates", () => {
  const parsed = RadarModel.parseLocationFile(
    JSON.stringify({ name: "Marmeleiro", latitude: -26.1478, longitude: -53.0272 }))
  assert.deepStrictEqual(parsed, {
    name: "Marmeleiro", latitude: -26.1478, longitude: -53.0272, valid: true
  })
})

test("an unreadable location file reads as unset rather than throwing", () => {
  for (const raw of ["", "   ", "not json", "null", null, undefined]) {
    assert.strictEqual(RadarModel.parseLocationFile(raw).valid, false, JSON.stringify(raw))
  }
})

test("zero is a real coordinate", () => {
  // The guard rejects absent coordinates, not falsy ones. Null Island is
  // uninhabited, but 0 degrees of latitude is most of Ecuador and Kenya.
  const parsed = RadarModel.parseLocationFile(
    JSON.stringify({ name: "Macapa", latitude: 0, longitude: -51.07 }))
  assert.strictEqual(parsed.valid, true)
  assert.strictEqual(parsed.latitude, 0)
})

// ------------------------------------------------------------------ geocoding

test("geocoding results become suggestions with a readable region", () => {
  const rows = RadarModel.parseGeocodingResults(JSON.stringify({
    results: [
      { name: "Curitiba", admin1: "Parana", country: "Brazil", latitude: -25.42, longitude: -49.27 },
      { name: "Nowhere", country: "Brazil", latitude: 1, longitude: 2 },
      { name: "Broken", latitude: 3 },
      { admin1: "no name", latitude: 1, longitude: 2 }
    ]
  }))
  assert.strictEqual(rows.length, 2)
  assert.strictEqual(rows[0].description, "Parana, Brazil")
  assert.strictEqual(rows[1].description, "Brazil", "a missing region leaves no stray comma")
})

test("an empty or broken geocoding response yields no suggestions", () => {
  for (const raw of ["", "{}", "not json", JSON.stringify({ results: [] }), null]) {
    assert.deepStrictEqual(RadarModel.parseGeocodingResults(raw), [], JSON.stringify(raw))
  }
})

test("committing the search field prefers the highlighted suggestion", () => {
  const suggestions = [
    { name: "Curitiba", latitude: -25.42, longitude: -49.27 },
    { name: "Curitibanos", latitude: -27.28, longitude: -50.58 }
  ]
  assert.strictEqual(RadarModel.locationCommit("cur", suggestions, 1).name, "Curitibanos")
  assert.strictEqual(RadarModel.locationCommit("cur", suggestions, 0).name, "Curitiba")
  // An index past the end still commits something rather than undefined.
  assert.strictEqual(RadarModel.locationCommit("cur", suggestions, 99).name, "Curitibanos")
})

test("committing free text yields a name with no coordinates", () => {
  const committed = RadarModel.locationCommit("  Marmeleiro  ", [], 0)
  assert.strictEqual(committed.name, "Marmeleiro", "surrounding whitespace is trimmed")
  assert.strictEqual(committed.latitude, null)
  assert.strictEqual(RadarModel.locationCommit("   ", [], 0).name, "", "blank commits nothing")
})

// ------------------------------------------------------------------ sampling

test("the forecast is sampled around the location, not only at it", () => {
  const points = RadarModel.samplePoints(-26.1478, -53.0272)
  assert.strictEqual(points.length, 5, "centre plus four cardinal points")
  assert.strictEqual(points[0].latitude, -26.1478)
  assert.strictEqual(points[0].longitude, -53.0272)
  for (const point of points.slice(1)) {
    assert.ok(Number.isFinite(point.latitude) && Number.isFinite(point.longitude))
  }
})

test("sample points sit close to the radius they were asked for", () => {
  const { TileMath } = require("./load.js")
  const points = RadarModel.samplePoints(-26.1478, -53.0272, 5)
  for (const point of points.slice(1)) {
    const km = TileMath.haversineKm(-26.1478, -53.0272, point.latitude, point.longitude)
    assert.ok(Math.abs(km - 5) < 0.1, `expected 5 km, got ${km}`)
  }
})

test("sampling an absent location produces no points at all", () => {
  // Regression: this once resolved to 0,0 and requested a forecast for the
  // Atlantic. An empty list is what stops the request being built.
  for (const [lat, lon] of [[null, null], ["", ""], [undefined, undefined], [NaN, 0], ["abc", "def"]]) {
    assert.deepStrictEqual(RadarModel.samplePoints(lat, lon), [], `${lat},${lon}`)
  }
})

test("sampling stays on the globe at the poles and the antimeridian", () => {
  for (const point of RadarModel.samplePoints(89.9, 179.9, 50)) {
    assert.ok(point.latitude >= -90 && point.latitude <= 90, `latitude ${point.latitude}`)
    assert.ok(point.longitude >= -180 && point.longitude <= 180, `longitude ${point.longitude}`)
  }
})

// ------------------------------------------------------------------ echoes

function greyTile(size, cells) {
  const pixels = new Uint8ClampedArray(size * size * 4)
  for (const [x, y, value] of cells) {
    const offset = (y * size + x) * 4
    pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = value
    pixels[offset + 3] = 255
  }
  return pixels
}

test("the strongest echo inside the radius is the one reported", () => {
  const size = 64
  const centre = size / 2
  // Weak echo two pixels north, strong echo four pixels east.
  const pixels = greyTile(size, [[centre, centre - 2, 80], [centre + 4, centre, 200]])
  const echo = RadarModel.analyzeEchoes(pixels, size, 0, 7, 500)

  assert.strictEqual(echo.found, true)
  assert.strictEqual(echo.intensity, 200)
  assert.strictEqual(echo.label, "heavy")
  assert.strictEqual(echo.compass, "E", "screen y grows south, so the bearing must be flipped")
  assert.strictEqual(echo.coveredPixels, 2, "both echoes counted, one reported")
})

test("an echo beyond the radius is not reported", () => {
  const size = 64
  const centre = size / 2
  const pixels = greyTile(size, [[centre + 20, centre, 240]])
  // At z7 on the equator a pixel is about 1.22 km, so 20 pixels is ~24 km.
  const inside = RadarModel.analyzeEchoes(pixels, size, 0, 7, 100)
  const outside = RadarModel.analyzeEchoes(pixels, size, 0, 7, 10)
  assert.strictEqual(inside.found, true)
  assert.strictEqual(outside.found, false)
  assert.strictEqual(outside.label, "clear")
  assert.strictEqual(outside.compass, "", "nothing found means nothing to point at")
})

test("a transparent pixel is not a zero-intensity echo", () => {
  const size = 32
  const pixels = new Uint8ClampedArray(size * size * 4)
  // Opaque black everywhere would be an echo of intensity 0; the alpha channel
  // is what separates "no data" from "no rain".
  const echo = RadarModel.analyzeEchoes(pixels, size, 0, 7, 100)
  assert.strictEqual(echo.found, false)
  assert.strictEqual(echo.coveredPixels, 0)
})

test("analysing a tile that never arrived is safe", () => {
  assert.strictEqual(RadarModel.analyzeEchoes(null, 512, 0, 7, 100).found, false)
  assert.strictEqual(RadarModel.analyzeEchoes(new Uint8ClampedArray(4), 0, 0, 7, 100).found, false)
})

test("intensity labels follow the calibrated bands", () => {
  assert.strictEqual(RadarModel.intensityLabel(0), "clear")
  assert.strictEqual(RadarModel.intensityLabel(1), "trace")
  assert.strictEqual(RadarModel.intensityLabel(60), "light")
  assert.strictEqual(RadarModel.intensityLabel(120), "moderate")
  assert.strictEqual(RadarModel.intensityLabel(170), "heavy")
  assert.strictEqual(RadarModel.intensityLabel(210), "severe")
  assert.strictEqual(RadarModel.intensityLabel(255), "severe")
})

test("a transparent centre pixel means a ground radar reaches here", () => {
  const size = 16
  const clear = new Uint8ClampedArray(size * size * 4)
  assert.strictEqual(RadarModel.hasCoverageAtCenter(clear, size), true)

  const masked = new Uint8ClampedArray(size * size * 4)
  const centre = Math.floor(size / 2)
  masked[(centre * size + centre) * 4 + 3] = 255
  assert.strictEqual(RadarModel.hasCoverageAtCenter(masked, size), false)

  // A tile that never loaded must not be read as "nowhere is covered", which
  // would tell every user their location has no radar.
  assert.strictEqual(RadarModel.hasCoverageAtCenter(null, size), true)
})

// ------------------------------------------------------------------ formatting

test("a frame time is the local clock, zero padded", () => {
  const epoch = 1788009000
  const date = new Date(epoch * 1000)
  const expected = String(date.getHours()).padStart(2, "0") + ":" +
                   String(date.getMinutes()).padStart(2, "0")
  assert.strictEqual(RadarModel.formatFrameTime(epoch), expected)
  assert.match(RadarModel.formatFrameTime(epoch), /^\d{2}:\d{2}$/)
  assert.strictEqual(RadarModel.formatFrameTime(0), "", "no frame, no time")
})

test("distance is printed with precision that matches its magnitude", () => {
  assert.strictEqual(RadarModel.formatDistance(4.23), "4.2 km")
  assert.strictEqual(RadarModel.formatDistance(42.7), "43 km")
  assert.strictEqual(RadarModel.formatDistance(142.4), "142 km")
})

test("the bar label says clear rather than nothing when there is no echo", () => {
  // An empty label reads as "the plugin is broken"; "clear" reads as weather.
  assert.strictEqual(RadarModel.summaryLabel(null), "clear")
  assert.strictEqual(RadarModel.summaryLabel({ found: false }), "clear")
  assert.strictEqual(
    RadarModel.summaryLabel({ found: true, label: "heavy", distanceKm: 42.3, compass: "SW" }),
    "heavy 42 km SW")
})

test("a manifest naming somewhere other than an https host is rejected", () => {
  // Every tile and mask is built from `host`, so a manifest carrying anything
  // else redirects all of them. Accepting "a string" is not accepting a URL.
  const withHost = host => JSON.stringify({
    host: host, radar: { past: [{ time: 1788009000, path: "/v2/radar/1" }] }
  })

  for (const bad of ["", "   ", "http://tilecache.rainviewer.com", "//evil.example",
                     "javascript:alert(1)", "ftp://x", "https://", "tilecache.rainviewer.com",
                     "https://a b", 'https://x"y', "https://x\\y", 42, null]) {
    assert.strictEqual(RadarModel.parseManifest(withHost(bad)), null, JSON.stringify(bad))
  }

  assert.notStrictEqual(RadarModel.parseManifest(withHost("https://tilecache.rainviewer.com")), null)
})

test("a host longer than any real one is rejected", () => {
  const long = "https://" + "a".repeat(300)
  assert.strictEqual(RadarModel.isTileHost(long), false)
  assert.strictEqual(RadarModel.isTileHost("https://tilecache.rainviewer.com"), true)
})

test("a name with no coordinates is a state of its own, not an empty one", () => {
  // The file is shared with the stock weather widget, which resolves names
  // server-side, so a name alone is a legitimate thing to find there. This
  // plugin cannot centre a map or fetch a forecast from one — and calling that
  // "no location" would tell somebody nothing happened when something did.
  const ready = RadarModel.parseLocationFile(
    JSON.stringify({ name: "Marmeleiro", latitude: -26.1478, longitude: -53.0272 }))
  const unresolved = RadarModel.parseLocationFile(JSON.stringify({ name: "Comsbao" }))
  const unset = RadarModel.parseLocationFile("")

  assert.strictEqual(RadarModel.locationState(ready), "ready")
  assert.strictEqual(RadarModel.locationState(unresolved), "unresolved")
  assert.strictEqual(RadarModel.locationState(unset), "unset")
  assert.strictEqual(RadarModel.locationState(null), "unset")
})

test("coordinates that fail validation leave a name unresolved, not ready", () => {
  for (const bad of [{ name: "x", latitude: 91, longitude: 0 },
                     { name: "x", latitude: null, longitude: null },
                     { name: "x", latitude: "abc", longitude: "def" }]) {
    const parsed = RadarModel.parseLocationFile(JSON.stringify(bad))
    assert.strictEqual(RadarModel.locationState(parsed), "unresolved", JSON.stringify(bad))
  }
})
