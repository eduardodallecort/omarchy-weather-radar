// RainViewer data model: URL construction, manifest parsing, and echo analysis.
//
// Everything here is a pure function over plain values so the networking and
// rendering layers stay thin, and so the parts that are easy to get subtly
// wrong (frame selection, intensity thresholds, distance math) can be reasoned
// about in isolation.
//
// API reference: https://www.rainviewer.com/api/weather-maps-api.html

.pragma library

.import "TileMath.js" as TileMath

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

// The plugin's glyph, defined once so the bar widget and the notification
// cannot drift apart. Built from the codepoint rather than written as an
// escape, because a JavaScript \u escape consumes exactly four hex digits:
// spelling this one out that way yields U+F043 followed by a stray digit
// rather than the glyph intended.
var GLYPH = String.fromCodePoint(0xF0437)   // nf-md-radar

var MANIFEST_URL = "https://api.rainviewer.com/public/weather-maps.json"

// RainViewer publishes a frame every 10 minutes. Polling faster only re-fetches
// bytes we already have, so this is the floor for every timer in the plugin.
var FRAME_INTERVAL_SEC = 600

// RainViewer's tile pyramid stops at z7 (~1.1 km/px at mid latitudes). The
// endpoint serves deeper zooms, but they only upscale the same data.
//
// The map still goes to MAX_MAP_ZOOM anyway. The reason people zoom in is to
// find out which town sits under a storm, and the town comes from the basemap,
// which has resolution to spare. So the radar layer keeps requesting z7 and is
// scaled up over a sharp basemap: honest about its own limit without holding
// the rest of the map hostage to it.
var MAX_RADAR_ZOOM = 7
var MIN_RADAR_ZOOM = 3
var MAX_MAP_ZOOM = 10

// Greyscale scheme. Luminance encodes reflectivity directly, which makes it the
// channel to measure on; the colour schemes below are for human eyes only.
var MEASUREMENT_SCHEME = 0

// Colour schemes offered to the user. IDs are RainViewer's; the names follow
// their published scheme list.
var COLOR_SCHEMES = [
  { id: 2, name: "TITAN" },
  { id: 4, name: "Meteored" },
  { id: 5, name: "NEXRAD Level III" },
  { id: 6, name: "Rainbow" },
  { id: 3, name: "The Weather Channel" },
  { id: 1, name: "Universal Blue" },
  { id: 7, name: "Dark Sky" },
  { id: 0, name: "Greyscale" }
]

function isKnownColorScheme(id) {
  for (var i = 0; i < COLOR_SCHEMES.length; i++) if (COLOR_SCHEMES[i].id === id) return true
  return false
}

function colorSchemeName(id) {
  for (var i = 0; i < COLOR_SCHEMES.length; i++) if (COLOR_SCHEMES[i].id === id) return COLOR_SCHEMES[i].name
  return "Unknown"
}

// ---------------------------------------------------------------------------
// URL construction
// ---------------------------------------------------------------------------

// Standard XYZ tile, used by the pannable map.
//   {host}{framePath}/{size}/{z}/{x}/{y}/{color}/{smooth}_{snow}.png
function tileUrl(host, framePath, size, zoom, x, y, colorScheme, smooth, snow) {
  if (!host || !framePath) return ""
  return host + framePath + "/" + size + "/" + zoom + "/" + x + "/" + y
    + "/" + colorScheme + "/" + (smooth ? 1 : 0) + "_" + (snow ? 1 : 0) + ".png"
}

// Coordinate-centred tile: the returned image is centred exactly on lat/lon
// rather than on a tile boundary. RainViewer documents this as the widget
// case, and it is what the alert samples — the centre pixel is the user's
// location by construction, so no grid arithmetic can drift.
function centeredTileUrl(host, framePath, size, zoom, lat, lon, colorScheme, smooth, snow) {
  if (!host || !framePath) return ""
  // The API requires a decimal point in both coordinates.
  return host + framePath + "/" + size + "/" + zoom + "/" + decimal(lat) + "/" + decimal(lon)
    + "/" + colorScheme + "/" + (smooth ? 1 : 0) + "_" + (snow ? 1 : 0) + ".png"
}

// Coverage mask: transparent where ground radar exists, opaque black where it
// does not. Lets the plugin say "no radar covers you" instead of showing an
// empty map that reads as a bug.
function coverageTileUrl(host, size, zoom, lat, lon) {
  if (!host) return ""
  return host + "/v2/coverage/0/" + size + "/" + zoom + "/" + decimal(lat) + "/" + decimal(lon) + "/0/0_0.png"
}

function decimal(value) {
  var text = String(Number(value))
  return text.indexOf(".") === -1 ? text + ".0" : text
}

// ---------------------------------------------------------------------------
// Manifest parsing
// ---------------------------------------------------------------------------

// Parse the weather-maps manifest into the shape the rest of the plugin uses.
// Returns null on anything unparseable so callers keep their previous state
// rather than blanking the map on one bad response.
function parseManifest(raw) {
  var text = String(raw || "").trim()
  if (text === "") return null

  var data
  try {
    data = JSON.parse(text)
  } catch (e) {
    return null
  }
  if (!data || typeof data.host !== "string" || !data.radar) return null

  var past = normalizeFrames(data.radar.past)
  if (past.length === 0) return null

  // `nowcast` carries short-range forecast frames. It has been observed empty
  // on the public endpoint, so it is optional throughout.
  var nowcast = normalizeFrames(data.radar.nowcast)

  return {
    host: data.host,
    generated: Number(data.generated) || 0,
    past: past,
    nowcast: nowcast,
    frames: past.concat(nowcast)
  }
}

function normalizeFrames(list) {
  if (!Array.isArray(list)) return []
  var frames = []
  for (var i = 0; i < list.length; i++) {
    var frame = list[i]
    if (!frame || typeof frame.path !== "string" || frame.path === "") continue
    var time = Number(frame.time)
    if (!isFinite(time) || time <= 0) continue
    frames.push({ time: time, path: frame.path })
  }
  frames.sort(function(a, b) { return a.time - b.time })
  return frames
}

function latestFrame(manifest) {
  // Checks the field rather than only the object: a caller can hold something
  // manifest-shaped that is not one of ours, and a missing `past` should read
  // as "no frames" rather than throw.
  if (!manifest || !manifest.past || manifest.past.length === 0) return null
  return manifest.past[manifest.past.length - 1]
}

// ---------------------------------------------------------------------------
// Location
// ---------------------------------------------------------------------------

// Omarchy stores the user's weather location in
// ~/.local/state/omarchy/settings/weather.json, owned by
// omarchy-weather-location. Reading the same file means the radar and the
// stock weather widget can never disagree about where "here" is, and the user
// configures it in one place.
function parseLocationFile(raw) {
  var unset = { name: "", latitude: null, longitude: null, valid: false }
  var text = String(raw || "").trim()
  if (text === "") return unset

  var data
  try {
    data = JSON.parse(text)
  } catch (e) {
    return unset
  }
  if (!data) return unset

  var latitude = parseFloat(data.latitude)
  var longitude = parseFloat(data.longitude)
  var valid = isFinite(latitude) && isFinite(longitude)
    && latitude >= -90 && latitude <= 90
    && longitude >= -180 && longitude <= 180

  return {
    name: String(data.name || ""),
    latitude: valid ? latitude : null,
    longitude: valid ? longitude : null,
    valid: valid
  }
}

// Geocoding, for the city picker. Same endpoint and same response shape the
// stock weather widget uses, so both pickers offer the same candidates for the
// same query.
var GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search"

function geocodingUrl(query, count) {
  return GEOCODING_URL + "?name=" + encodeURIComponent(String(query || ""))
    + "&count=" + (count || 5) + "&language=en&format=json"
}

// Open-Meteo geocoding response → suggestion rows.
function parseGeocodingResults(raw) {
  try {
    var data = JSON.parse(String(raw || "{}"))
    var results = data.results
    if (!results || !results.length) return []

    var out = []
    for (var i = 0; i < results.length; i++) {
      var r = results[i]
      if (!r || !r.name || r.latitude === undefined || r.longitude === undefined) continue
      var region = [r.admin1, r.country].filter(function(part) { return !!part }).join(", ")
      out.push({
        name: String(r.name),
        description: region,
        latitude: r.latitude,
        longitude: r.longitude
      })
    }
    return out
  } catch (e) {
    return []
  }
}

// What pressing Enter in the search field should commit: the highlighted
// suggestion when there is one, otherwise the raw text with no coordinates —
// which omarchy-weather-location stores as a name for the forecast provider to
// resolve. A name without coordinates cannot centre a map, so the radar treats
// that case as "no location" until the file gains coordinates.
function locationCommit(text, suggestions, selectedIndex) {
  var name = String(text || "").replace(/^\s+|\s+$/g, "")
  if (name === "") return { name: "", latitude: null, longitude: null }

  var choices = suggestions || []
  var index = Math.max(0, Math.min(parseInt(selectedIndex, 10) || 0, choices.length - 1))
  var suggestion = choices[index]
  if (suggestion) return suggestion

  return { name: name, latitude: null, longitude: null }
}

// How far around the configured point the forecast is sampled, in kilometres.
//
// A point forecast is a point, but a town is not. The model runs on a grid
// roughly 8-10 km across, and a stored coordinate lands wherever it lands
// inside that grid — measured against Marmeleiro, the centre of town resolves
// to a cell 3.8 km away, and a point 1 km south already belongs to the next
// cell over. Sampling only the centre therefore answers for one arbitrary
// 8 km patch rather than for the place someone lives in.
//
// Five kilometres is chosen to cover a town's own footprint without becoming a
// regional forecast. Anything inside it is still "here" by any ordinary
// reading; widening it to the alert radius would mean announcing every shower
// within an hour's drive.
var SAMPLE_RADIUS_KM = 5

// Centre plus the four cardinal points at SAMPLE_RADIUS_KM. Five coordinates
// travel in a single request, so the extra coverage costs a larger response
// rather than more requests.
function samplePoints(lat, lon, km) {
  // parseFloat rather than Number, because an unset location carries null and
  // Number(null) is 0 — a guard built on it would admit the exact case it
  // exists to reject and place the caller off the coast of west Africa.
  // parseFloat(null) and parseFloat("") are both NaN, which is what is meant.
  lat = parseFloat(lat)
  lon = parseFloat(lon)
  if (!isFinite(lat) || !isFinite(lon)) return []

  var radius = km || SAMPLE_RADIUS_KM
  var dLat = radius / 111.32
  // Longitude degrees shrink towards the poles; without the cosine the
  // east-west samples would be far too close together at high latitude.
  var cos = Math.cos(TileMath.toRadians(lat))
  var dLon = Math.abs(cos) < 0.01 ? 0 : radius / (111.32 * cos)

  return [
    { latitude: lat, longitude: lon },
    { latitude: clampLat(lat + dLat), longitude: lon },
    { latitude: clampLat(lat - dLat), longitude: lon },
    { latitude: lat, longitude: wrapLon(lon + dLon) },
    { latitude: lat, longitude: wrapLon(lon - dLon) }
  ]
}

function clampLat(lat) {
  return Math.max(-90, Math.min(90, lat))
}

function wrapLon(lon) {
  var wrapped = ((lon + 180) % 360 + 360) % 360 - 180
  return wrapped
}

// ---------------------------------------------------------------------------
// Echo analysis
// ---------------------------------------------------------------------------

// Reflectivity bands, expressed on the 0-255 luminance of the greyscale
// scheme. RainViewer does not publish the exact luminance-to-dBZ mapping, so
// these are calibrated against the scheme's 22 quantisation steps and named
// for what they mean to a person rather than claiming a dBZ figure the API
// does not guarantee.
var INTENSITY_NONE = 0
var INTENSITY_LIGHT = 60      // drizzle to light rain
var INTENSITY_MODERATE = 120  // steady rain
var INTENSITY_HEAVY = 170     // downpour, convective core
var INTENSITY_SEVERE = 210    // very intense core, hail likely

function intensityLabel(value) {
  if (value >= INTENSITY_SEVERE) return "severe"
  if (value >= INTENSITY_HEAVY) return "heavy"
  if (value >= INTENSITY_MODERATE) return "moderate"
  if (value >= INTENSITY_LIGHT) return "light"
  if (value > INTENSITY_NONE) return "trace"
  return "clear"
}

// Scan a coordinate-centred greyscale tile for the strongest echo within
// `radiusKm` of the centre — which is the user's location.
//
// `pixels` is the RGBA byte array from Canvas getImageData; `size` is the tile
// edge in pixels. Returns the strongest cell found plus where it sits, so the
// alert can say "heavy rain 42 km SW" instead of just "rain nearby".
function analyzeEchoes(pixels, size, lat, zoom, radiusKm) {
  var result = {
    found: false,
    intensity: 0,
    label: "clear",
    distanceKm: 0,
    bearing: 0,
    compass: "",
    coveredPixels: 0
  }
  if (!pixels || size <= 0) return result

  var center = size / 2
  var metersPerPixel = TileMath.metersPerPixel(lat, zoom)
  var radiusPixels = radiusKm * 1000 / metersPerPixel
  var maxRadius = Math.min(radiusPixels, center)

  // Walk only the bounding box of the search circle; at z7 with a 100 km
  // radius that is roughly a 180x180 window inside a 512 tile.
  var lo = Math.max(0, Math.floor(center - maxRadius))
  var hi = Math.min(size - 1, Math.ceil(center + maxRadius))

  for (var y = lo; y <= hi; y++) {
    for (var x = lo; x <= hi; x++) {
      var dx = x - center
      var dy = y - center
      var distancePixels = Math.sqrt(dx * dx + dy * dy)
      if (distancePixels > maxRadius) continue

      var offset = (y * size + x) * 4
      // Greyscale scheme: all three channels carry the same value, and alpha
      // is zero where there is no echo at all.
      if (pixels[offset + 3] === 0) continue
      var intensity = pixels[offset]
      if (intensity <= INTENSITY_NONE) continue

      result.coveredPixels++
      if (intensity > result.intensity) {
        result.found = true
        result.intensity = intensity
        result.distanceKm = distancePixels * metersPerPixel / 1000
        // Screen y grows south, so north is -dy.
        result.bearing = (TileMath.toDegrees(Math.atan2(dx, -dy)) + 360) % 360
      }
    }
  }

  result.label = intensityLabel(result.intensity)
  result.compass = result.found ? TileMath.compassPoint(result.bearing) : ""
  return result
}

// Is the centre pixel of a coverage mask transparent? Transparent means a
// ground radar reaches this location.
function hasCoverageAtCenter(pixels, size) {
  if (!pixels || size <= 0) return true
  var center = Math.floor(size / 2)
  var offset = (center * size + center) * 4
  return pixels[offset + 3] === 0
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatFrameTime(epochSeconds) {
  if (!epochSeconds) return ""
  var date = new Date(epochSeconds * 1000)
  return pad(date.getHours()) + ":" + pad(date.getMinutes())
}

function pad(value) {
  return value < 10 ? "0" + value : String(value)
}

function formatDistance(km) {
  if (km >= 100) return Math.round(km) + " km"
  if (km >= 10) return km.toFixed(0) + " km"
  return km.toFixed(1) + " km"
}

// Short bar label, e.g. "heavy 42 km SW" or "clear".
function summaryLabel(echo) {
  if (!echo || !echo.found) return "clear"
  return echo.label + " " + formatDistance(echo.distanceKm) + " " + echo.compass
}
