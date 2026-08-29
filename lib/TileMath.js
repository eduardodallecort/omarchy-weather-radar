// Web Mercator ("slippy map") tile math.
//
// Qt ships QtLocation's `Map` element only when qt6-location is installed, and
// Omarchy does not depend on it. Rather than add a package the rest of the
// shell does not need, this plugin renders the map itself as a grid of XYZ
// tiles — which is all a raster basemap ever is. Every projection helper the
// renderer needs lives here as a pure function, so it is reasoned about and
// tested without a running shell — see test/tile-math.test.js.
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

// The centre latitude that keeps a viewport inside the projection.
//
// Mercator ends at 85.0511 degrees, and the map has no business showing what
// is past it: pan south of Antarctica and the world's bottom edge crosses the
// panel, leaving a hard horizontal line with nothing under it while the map
// stops responding. Every slippy map constrains the centre for this reason.
//
// The constraint is on the viewport, not on the centre — half a panel of world
// has to remain on each side of it. Zooming out therefore tightens it, since
// the same pixels cover more of the globe, which is why this has to be applied
// again whenever the zoom changes and not only when the map is dragged.
function constrainLatitude(lat, zoom, height) {
  var world = Math.pow(2, zoom)
  var half = (height / 2) / TILE_SIZE

  // Zoomed out far enough that the whole world is shorter than the panel there
  // is no valid centre but the middle of it.
  if (half * 2 >= world) return 0

  var y = latToTileY(lat, zoom)
  return tileYToLat(Math.max(half, Math.min(world - half, y)), zoom)
}

// The centre that puts a coordinate at a given pixel of the viewport.
//
// The inverse of projectToViewport in its centre argument, and what zooming
// towards the pointer is built from: read which coordinate is under the
// cursor, then ask where the map has to be centred for that same coordinate to
// stay under it at the new zoom.
//
// Latitude is clamped, because Mercator has no room above 85 degrees. Close
// enough to a pole the anchor therefore slides out from under the pointer,
// which is the same compromise every slippy map makes.
function centerForPoint(lat, lon, screenX, screenY, zoom, width, height) {
  var pointX = lonToTileX(lon, zoom)
  var pointY = latToTileY(lat, zoom)
  var centerX = pointX - (screenX - width / 2) / TILE_SIZE
  var centerY = pointY - (screenY - height / 2) / TILE_SIZE
  return {
    latitude: clampLatitude(tileYToLat(centerY, zoom)),
    longitude: tileXToLon(centerX, zoom)
  }
}

// Longitude normalised into [-180, 180). The world repeats east-west, so a
// coordinate that has been panned past the antimeridian names a real place;
// this is which place.
function wrapLongitude(lon) {
  return ((lon + 180) % 360 + 360) % 360 - 180
}

// The copy of `lon` that lies closest to `reference`, which may be outside
// [-180, 180).
//
// Two points either side of the antimeridian are two degrees apart on the
// globe and 358 apart in their coordinates. Anything positioned by subtracting
// one longitude from another — a marker, a distance in pixels — has to ask for
// the near copy, or it places Suva most of a world away from a map centred on
// Fiji.
function nearestLongitude(lon, reference) {
  return reference + wrapLongitude(lon - reference)
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
