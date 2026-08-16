// Web Mercator ("slippy map") tile math.
//
// Qt ships QtLocation's `Map` element only when qt6-location is installed, and
// Omarchy does not depend on it. Rather than add a package the rest of the
// shell does not need, this plugin renders the map itself as a grid of XYZ
// tiles — which is all a raster basemap ever is. Every projection helper the
// renderer needs lives here as a pure function so it can be reasoned about
// (and eventually tested) without a running shell.
//
// Conventions, matching the OSM/XYZ scheme every provider in this plugin uses:
//   - zoom z has 2^z tiles per axis
//   - x grows east from -180 degrees, y grows south from +85.0511 degrees
//   - tile coordinates are returned fractional; floor() gives the tile, the
//     remainder gives the offset inside it

.pragma library

var TILE_SIZE = 256

// Circumference of the Earth at the equator, in meters, divided by 256. The
// constant every Web Mercator implementation uses for meters-per-pixel at z0.
var EQUATOR_METERS_PER_PIXEL = 156543.03392804097

var MAX_LATITUDE = 85.0511287798

function clampLatitude(lat) {
  return Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, lat))
}

function toRadians(degrees) {
  return degrees * Math.PI / 180
}

function toDegrees(radians) {
  return radians * 180 / Math.PI
}

// Fractional tile X for a longitude. Wraps nothing: callers that pan past the
// antimeridian are expected to wrap the integer tile index, not the longitude.
function lonToTileX(lon, zoom) {
  return (lon + 180) / 360 * Math.pow(2, zoom)
}

// Fractional tile Y for a latitude, via the Mercator projection. Latitudes
// beyond +/-85.0511 do not exist on this projection and are clamped rather
// than allowed to produce infinities.
function latToTileY(lat, zoom) {
  var rad = toRadians(clampLatitude(lat))
  var projected = Math.log(Math.tan(rad) + 1 / Math.cos(rad))
  return (1 - projected / Math.PI) / 2 * Math.pow(2, zoom)
}

function tileXToLon(x, zoom) {
  return x / Math.pow(2, zoom) * 360 - 180
}

function tileYToLat(y, zoom) {
  var n = Math.PI * (1 - 2 * y / Math.pow(2, zoom))
  return toDegrees(Math.atan(Math.sinh(n)))
}

// Ground resolution at a given latitude. Mercator stretches east-west away
// from the equator, so this shrinks with cos(lat) — which is why the alert
// radius has to be converted here rather than assumed constant.
function metersPerPixel(lat, zoom) {
  return EQUATOR_METERS_PER_PIXEL * Math.cos(toRadians(clampLatitude(lat))) / Math.pow(2, zoom)
}

function kmToPixels(km, lat, zoom) {
  return km * 1000 / metersPerPixel(lat, zoom)
}

function pixelsToKm(pixels, lat, zoom) {
  return pixels * metersPerPixel(lat, zoom) / 1000
}

// Great-circle distance in kilometers. Used to turn "is this echo inside my
// alert radius" into a number; the flat-earth approximation would drift by a
// few percent at 100 km, which is enough to matter at the alert boundary.
function haversineKm(lat1, lon1, lat2, lon2) {
  var earthRadiusKm = 6371.0088
  var dLat = toRadians(lat2 - lat1)
  var dLon = toRadians(lon2 - lon1)
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
    + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2))
    * Math.sin(dLon / 2) * Math.sin(dLon / 2)
  return 2 * earthRadiusKm * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// Compass bearing from one point to another, in degrees clockwise from north.
// Reported in alerts so "a storm is 40 km away" becomes actionable.
function bearingDegrees(lat1, lon1, lat2, lon2) {
  var phi1 = toRadians(lat1)
  var phi2 = toRadians(lat2)
  var dLon = toRadians(lon2 - lon1)
  var y = Math.sin(dLon) * Math.cos(phi2)
  var x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon)
  return (toDegrees(Math.atan2(y, x)) + 360) % 360
}

var COMPASS_POINTS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]

function compassPoint(bearing) {
  var index = Math.round(((bearing % 360) + 360) % 360 / 45) % 8
  return COMPASS_POINTS[index]
}

// The set of tiles needed to cover `width` x `height` pixels centred on a
// coordinate. Returns the integer tile range plus the pixel offset of the
// top-left tile relative to the viewport, which is what the renderer positions
// its Image grid with.
function viewportTiles(lat, lon, zoom, width, height) {
  var centerX = lonToTileX(lon, zoom)
  var centerY = latToTileY(lat, zoom)

  var halfTilesX = width / 2 / TILE_SIZE
  var halfTilesY = height / 2 / TILE_SIZE

  var minX = Math.floor(centerX - halfTilesX)
  var maxX = Math.ceil(centerX + halfTilesX) - 1
  var minY = Math.floor(centerY - halfTilesY)
  var maxY = Math.ceil(centerY + halfTilesY) - 1

  // Where tile (minX, minY) lands inside the viewport. Usually negative: the
  // first tile starts off-screen because the centre rarely falls on a seam.
  var originX = width / 2 - (centerX - minX) * TILE_SIZE
  var originY = height / 2 - (centerY - minY) * TILE_SIZE

  return {
    minX: minX,
    maxX: maxX,
    minY: minY,
    maxY: maxY,
    originX: originX,
    originY: originY,
    centerX: centerX,
    centerY: centerY
  }
}

// Pixel position of a coordinate inside a viewport laid out by viewportTiles.
function projectToViewport(lat, lon, centerLat, centerLon, zoom, width, height) {
  var centerX = lonToTileX(centerLon, zoom)
  var centerY = latToTileY(centerLat, zoom)
  var pointX = lonToTileX(lon, zoom)
  var pointY = latToTileY(lat, zoom)
  return {
    x: width / 2 + (pointX - centerX) * TILE_SIZE,
    y: height / 2 + (pointY - centerY) * TILE_SIZE
  }
}

// Inverse of projectToViewport: which coordinate is under this pixel. Used to
// turn a drag gesture into a new centre.
function unprojectFromViewport(x, y, centerLat, centerLon, zoom, width, height) {
  var centerX = lonToTileX(centerLon, zoom)
  var centerY = latToTileY(centerLat, zoom)
  var tileX = centerX + (x - width / 2) / TILE_SIZE
  var tileY = centerY + (y - height / 2) / TILE_SIZE
  return {
    latitude: tileYToLat(tileY, zoom),
    longitude: tileXToLon(tileX, zoom)
  }
}

// Tile indices wrap east-west (the world repeats) but not north-south (there
// is nothing above the pole). Y outside the valid range means "no tile".
function wrapTileX(x, zoom) {
  var n = Math.pow(2, zoom)
  return ((x % n) + n) % n
}

function isValidTileY(y, zoom) {
  return y >= 0 && y < Math.pow(2, zoom)
}
