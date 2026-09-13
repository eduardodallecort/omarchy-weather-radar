// RainViewer data model: URL construction, manifest and location parsing,
// forecast sampling and echo analysis.
//
// Everything here is a pure function over plain values, so the networking and
// rendering layers stay thin and the parts that are easy to get subtly wrong —
// a manifest that half-parses, a location carrying no coordinates, the
// reflectivity bands — are pinned by test/radar-model.test.js.
//
// The storm alert bands live in Alerts.js rather than here: these are
// reflectivity read off a radar image, those are rain rate read off a
// forecast.
//
// API reference: https://www.rainviewer.com/api/weather-maps-api.html

.pragma library

.import "TileMath.js" as TileMath

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

var MANIFEST_URL = "https://api.rainviewer.com/public/weather-maps.json"
var FORECAST_URL = "https://api.open-meteo.com/v1/forecast"

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

// Every response is collected whole into the process that owns the bar, the
// panels and the lock screen, so every request carries a ceiling on bytes as
// well as on time. `--max-time` bounds only how long a transfer may run: a
// host that answers fast enough can send as much as the link carries for the
// whole window, and a captive portal or a hijacked name is an ordinary thing
// to meet on a laptop.
//
// Measured against the real endpoints, with room for them to grow: the
// RainViewer manifest is 766 bytes, a five-result geocoding answer 1,834, and
// a five-point forecast at the widest window this plugin asks for 9,269.
//
// curl enforces this during the transfer rather than only against a declared
// length — checked against a chunked 26 MB response, which it cut at the
// ceiling and left with exit 63.
var MANIFEST_MAX_BYTES = 65536
var GEOCODING_MAX_BYTES = 65536
var FORECAST_MAX_BYTES = 262144

// The one place a request is built, so that no call site can leave a ceiling
// off. `-f` makes an HTTP error an exit code rather than an error page parsed
// as data.
//
// `--globoff` because curl otherwise reads `[1-1000000]` or `{a,b}` in a URL
// as a list of URLs to fetch, and parts of these URLs come from outside.
// `--proto =https` because nothing here is fetched any other way.
function fetchCommand(url, seconds, maxBytes) {
  return ["curl", "-fsS", "--globoff", "--proto", "=https",
          "--max-time", String(seconds),
          "--max-filesize", String(maxBytes),
          url]
}

function manifestCommand() {
  return fetchCommand(MANIFEST_URL, 10, MANIFEST_MAX_BYTES)
}

// Open-Meteo takes several coordinates in one request and answers with an
// array, which is how five sample points around a town cost one call.
function forecastUrl(points, slots, hours) {
  var latitudes = []
  var longitudes = []
  for (var i = 0; i < points.length; i++) {
    latitudes.push(points[i].latitude.toFixed(4))
    longitudes.push(points[i].longitude.toFixed(4))
  }
  return FORECAST_URL
    + "?latitude=" + latitudes.join(",")
    + "&longitude=" + longitudes.join(",")
    + "&minutely_15=precipitation,precipitation_probability"
    + "&hourly=cape,wind_gusts_10m"
    + "&forecast_minutely_15=" + slots
    + "&forecast_hours=" + hours
    + "&timezone=auto"
}

function forecastCommand(points, slots, hours) {
  return fetchCommand(forecastUrl(points, slots, hours), 12, FORECAST_MAX_BYTES)
}

function geocodingCommand(query, count) {
  return fetchCommand(geocodingUrl(query, count), 5, GEOCODING_MAX_BYTES)
}

// RainViewer publishes a frame every 10 minutes. Polling faster only re-fetches
// bytes we already have, so this is the floor for every timer in the plugin.
var FRAME_INTERVAL_SEC = 600

// A frame is listed about a minute and a half after its time, measured on
// 2026-09-12. The open map asks for the next one a minute after it is due,
// then every minute until it appears.
var PUBLISH_GRACE_SEC = 60
var MANIFEST_RECHECK_SEC = 60

// How long the open map waits before asking for the frame list again, given
// the time of the newest frame it holds. Timed from that frame rather than
// from whenever the map was opened, so a new frame shows up soon after it is
// published instead of up to ten minutes later. Never sooner than the recheck
// interval, so a frame that is late costs one small request a minute, and
// never later than one full cycle, so a clock that has moved cannot put the
// question off for hours.
function nextManifestCheckMs(latestFrameTime, nowMs) {
  var floor = MANIFEST_RECHECK_SEC * 1000
  var ceiling = (FRAME_INTERVAL_SEC + PUBLISH_GRACE_SEC) * 1000
  if (!isFinite(latestFrameTime) || latestFrameTime <= 0) return floor
  var due = (latestFrameTime + FRAME_INTERVAL_SEC + PUBLISH_GRACE_SEC) * 1000 - nowMs
  return Math.max(floor, Math.min(ceiling, due))
}

// Open-Meteo's minutely_15 series is quarter-hourly, which is the finest the
// forecast can be different from what is already held. Named separately from
// the radar's cycle because they are different sources that happen to be close
// — borrowing one for the other is right until one of them changes.
var FORECAST_INTERVAL_SEC = 900

// RainViewer's tile pyramid stops at z7 (~1.1 km/px at mid latitudes). The
// endpoint serves deeper zooms, but they only upscale the same data.
//
// The map still goes past that, because the reason people zoom in is to find
// out which town sits under a storm, and the town comes from the basemap. So
// the radar layer keeps requesting z7 and is scaled up over ground that is
// still sharpening: honest about its own limit without holding the rest of the
// map hostage to it.
//
// It stops at z9 rather than going deeper because that is where the ground
// runs out too. The basemap is Natural Earth at 1:10 million, which is drawn
// for scales down to roughly 1:2 million; past z9 the coastline would be
// magnified beyond the accuracy it claims, over radar that was already being
// upscaled two levels earlier. A zoom level where neither layer has anything
// left to say is a zoom level that only looks like detail.
var MAX_RADAR_ZOOM = 7
var MIN_RADAR_ZOOM = 3
var MAX_MAP_ZOOM = 9

// The scheme documented as greyscale, kept for the id rather than for what it
// was believed to give.
//
// It does not return a greyscale tile. Measured 2026-08-30 at z7, the deepest
// zoom RainViewer serves: schemes 0 through 9 collapse to at most two distinct
// images — southern Brazil returned one for 0,1,2,3,7,8 and another for
// 4,5,6,9, while the US midwest and western Europe returned a single image for
// all ten — and every variant is fully coloured, with no greyscale pixels at
// all in any of the three. Values that are not schemes return a scheme's image
// too, so the parameter is inert or close to it.
//
// Nothing reads this. It is left because the id is still the id, and removed
// belief is cheaper to correct than absent belief is to rediscover.
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
  if (!data || !data.radar) return null

  // Every tile and mask this plugin requests is built from `host`, so a
  // manifest that carried anything else would redirect all of them. Accepting
  // "a string" is not accepting a URL.
  if (!isTileHost(data.host)) return null

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

// The manifest names the host its tiles come from. It must be a plain https
// origin, a hostname and at most a port: http would be a silent downgrade of
// everything that follows, and anything else is not somewhere to send a
// request at all.
function isTileHost(value) {
  if (typeof value !== "string" || value.length > 256) return false
  return /^https:\/\/[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::[0-9]{1,5})?$/.test(value)
}

// A frame's path goes into every tile URL, and those URLs are handed to curl
// and to Qt. RainViewer's are short opaque names like "/v2/radar/1b68f6b5bbb1",
// so letters, digits, underscores, hyphens and slashes are all a path may
// hold. Anything else, a bracket curl would expand, a query, an escape, a
// dot, is refused along with its frame.
function isFramePath(value) {
  if (typeof value !== "string" || value.length > 128) return false
  return /^(?:\/[A-Za-z0-9_-]+)+$/.test(value)
}

// RainViewer publishes about thirteen past frames and a few forecast ones.
// Kept to the newest this many, so that a manifest cannot turn into thousands
// of frames and every tile each of them would ask for.
var MAX_FRAMES = 32

function normalizeFrames(list) {
  if (!Array.isArray(list)) return []
  var frames = []
  for (var i = 0; i < list.length; i++) {
    var frame = list[i]
    if (!frame || !isFramePath(frame.path)) continue
    var time = Number(frame.time)
    if (!isFinite(time) || time <= 0 || Math.floor(time) !== time) continue
    frames.push({ time: time, path: frame.path })
  }
  frames.sort(function(a, b) { return a.time - b.time })
  return frames.slice(-MAX_FRAMES)
}

// Whether a new answer to the frame list is worth taking. Not when it lists
// the same frames from the same host, which is what every check made while a
// frame is late gets back, and taking it would restart everything that
// follows a new list for nothing. Not when its newest frame is older than the
// one in hand, a cache somewhere between answering with a list it kept, which
// would take the newest frame away.
//
// A list in hand whose newest frame is more than an hour in the future, by
// this machine's clock, is not one to hold on to: taken from a bad answer, or
// from before the clock was corrected, it would otherwise refuse every real
// list after it for the rest of the session.
var FUTURE_TOLERANCE_SEC = 3600

function isNewerManifest(current, next, nowSec) {
  if (!next) return false
  if (!current) return true
  var a = latestFrame(current)
  var b = latestFrame(next)
  if (!b) return false
  if (!a) return true
  var now = isFinite(nowSec) ? nowSec : Date.now() / 1000
  if (a.time > now + FUTURE_TOLERANCE_SEC && b.time <= now + FUTURE_TOLERANCE_SEC) return true
  if (b.time < a.time) return false
  if (b.time > a.time || current.host !== next.host) return true
  var before = current.past || []
  var after = next.past || []
  if (before.length !== after.length) return true
  for (var i = 0; i < after.length; i++) {
    if (before[i].time !== after[i].time || before[i].path !== after[i].path) return true
  }
  return false
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

// What a stored location can actually be used for.
//
// The file is shared with the stock weather widget, and a name with no
// coordinates is a legitimate thing to find in it: that widget resolves names
// server-side, so "Marmeleiro" alone is a location as far as it is concerned.
// This plugin cannot use one — a map has to be centred on a coordinate and the
// forecast is fetched by coordinate — so the three cases are different states
// rather than two, and saying "no location" for a name somebody just typed
// would be telling them nothing happened when something did.
//
//   "ready"       coordinates, everything works
//   "unresolved"  a name, but nothing to centre or forecast on
//   "unset"       nothing stored
function locationState(location) {
  if (!location) return "unset"
  if (location.valid === true) return "ready"
  return String(location.name || "") !== "" ? "unresolved" : "unset"
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
    { latitude: lat, longitude: TileMath.wrapLongitude(lon + dLon) },
    { latitude: lat, longitude: TileMath.wrapLongitude(lon - dLon) }
  ]
}

function clampLat(lat) {
  return Math.max(-90, Math.min(90, lat))
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
      // Alpha is zero where there is no echo at all, which is the one part of
      // this that holds.
      //
      // The red channel is *not* an intensity. This was written for the tile
      // MEASUREMENT_SCHEME was believed to return, and that tile does not
      // exist — see the measurement there. On the coloured tile the endpoint
      // actually serves, reading one channel reads a component of a colour,
      // and the palette is not monotonic in it. Nothing calls this function,
      // so nothing is wrong today; reviving it means deriving a reading from
      // all three channels against whichever palette arrives, which is not
      // controllable either.
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
