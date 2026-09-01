// The offline basemap: decoding data/basemap.bin, and turning it into screen
// coordinates.
//
// The plugin draws the ground itself rather than fetching raster tiles. The
// world's coastlines do not change, so they ship with the plugin — which is
// cheaper than a request per tile, works with no network, and cannot be
// withdrawn. A keyless tile endpoint is a policy rather than a property, and
// the one this plugin used began stamping "API KEY REQUIRED" across every tile
// in August 2026, for every installation at once, with nothing failing
// anywhere.
//
// Geometry is stored quantised to integers and delta-encoded, so decoding
// lands it in typed arrays with no per-point objects. Features are flattened
// into three parallel arrays rather than nested structures, because the
// renderer walks them on every pan and the cost of a million small objects is
// paid in garbage collection during a drag.
//
// The format is written by tools/build-basemap.py and described there.

.pragma library

.import "TileMath.js" as TileMath

var MAGIC = "OWRB"
var FORMAT_VERSION = 1

var LINE = 0
var POLYGON = 1
var POINTS = 2

// ---------------------------------------------------------------------------
// Reading the container
// ---------------------------------------------------------------------------

function Reader(buffer) {
  this.bytes = new Uint8Array(buffer)
  this.end = this.bytes.length
  this.at = 0
}

// Every read is bounds-checked, and running off the end throws rather than
// returning a value.
//
// Reading past a Uint8Array yields undefined, and `undefined & 0x7F` is 0 —
// which terminates a varint and looks exactly like a byte that was really
// there. A file truncated by a failed write or a half-finished download would
// decode into plausible nonsense: a coastline through the wrong ocean, with
// nothing anywhere reporting a fault. Throwing is what lets decode() answer
// null instead.
Reader.prototype.u8 = function() {
  if (this.at >= this.end) throw new Error("basemap: read past end of data")
  return this.bytes[this.at++]
}

Reader.prototype.varint = function() {
  var value = 0
  var shift = 0
  while (true) {
    var byte = this.u8()
    value += (byte & 0x7F) * Math.pow(2, shift)
    if ((byte & 0x80) === 0) return value
    shift += 7
    if (shift > 56) throw new Error("basemap: varint too long")
  }
}

Reader.prototype.signed = function() {
  var value = this.varint()
  return (value % 2) === 0 ? value / 2 : -(value + 1) / 2
}

// UTF-8 by hand: QML's JavaScript engine has no TextDecoder, and the place
// names carry accents in every alphabet Natural Earth writes in Latin script.
Reader.prototype.string = function() {
  var length = this.varint()
  var end = this.at + length
  if (end > this.end) throw new Error("basemap: string runs past end of data")
  var out = ""
  while (this.at < end) {
    var byte = this.u8()
    var codepoint
    if (byte < 0x80) {
      codepoint = byte
    } else if (byte < 0xE0) {
      codepoint = ((byte & 0x1F) << 6) | (this.u8() & 0x3F)
    } else if (byte < 0xF0) {
      codepoint = ((byte & 0x0F) << 12)
        | ((this.u8() & 0x3F) << 6)
        | (this.u8() & 0x3F)
    } else {
      codepoint = ((byte & 0x07) << 18)
        | ((this.u8() & 0x3F) << 12)
        | ((this.u8() & 0x3F) << 6)
        | (this.u8() & 0x3F)
    }
    out += String.fromCodePoint(codepoint)
  }
  return out
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

// Returns null rather than throwing on anything unreadable. A basemap that
// fails to load leaves the radar drawn over an empty ground, which is a
// degraded map; an exception during startup is a broken shell.
function decode(buffer) {
  if (!buffer || !buffer.byteLength) return null

  try {
    var reader = new Reader(buffer)

    var magic = ""
    for (var m = 0; m < 4; m++) magic += String.fromCharCode(reader.u8())
    if (magic !== MAGIC) return null
    if (reader.u8() !== FORMAT_VERSION) return null

    var quantum = reader.varint()
    if (!(quantum > 0)) return null

    var layers = {}
    var order = []
    var layerCount = reader.varint()
    for (var i = 0; i < layerCount; i++) {
      var layer = decodeLayer(reader, quantum)
      layers[layer.name] = layer
      order.push(layer.name)
    }

    return { quantum: quantum, layers: layers, order: order }
  } catch (e) {
    return null
  }
}

function decodeLayer(reader, quantum) {
  var name = reader.string()
  var kind = reader.u8()
  var minZoom = reader.u8()
  var maxZoom = reader.u8()
  var count = reader.varint()

  if (kind === POINTS) return decodePlaces(reader, name, kind, minZoom, maxZoom, count, quantum)

  // Two passes. The first counts rings and points so the typed arrays can be
  // allocated once at the right size; the second fills them. Growing arrays
  // instead would copy several megabytes repeatedly.
  var start = reader.at
  var ringTotal = 0
  var pointTotal = 0
  var f, r
  for (f = 0; f < count; f++) {
    var ringCount = reader.varint()
    ringTotal += ringCount
    for (r = 0; r < ringCount; r++) {
      var pointCount = reader.varint()
      pointTotal += pointCount
      for (var p = 0; p < pointCount * 2; p++) reader.varint()
    }
  }

  reader.at = start

  var coordinates = new Int32Array(pointTotal * 2)
  var ringStart = new Int32Array(ringTotal + 1)
  var featureRing = new Int32Array(count + 1)
  var bounds = new Int32Array(count * 4)

  var ringIndex = 0
  var pointIndex = 0

  for (f = 0; f < count; f++) {
    featureRing[f] = ringIndex
    var minX = 2147483647, minY = 2147483647
    var maxX = -2147483648, maxY = -2147483648

    var rings = reader.varint()
    for (r = 0; r < rings; r++) {
      ringStart[ringIndex++] = pointIndex
      var points = reader.varint()
      var x = 0, y = 0
      for (var i = 0; i < points; i++) {
        x += reader.signed()
        y += reader.signed()
        coordinates[pointIndex * 2] = x
        coordinates[pointIndex * 2 + 1] = y
        pointIndex++
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }

    bounds[f * 4] = minX
    bounds[f * 4 + 1] = minY
    bounds[f * 4 + 2] = maxX
    bounds[f * 4 + 3] = maxY
  }

  featureRing[count] = ringIndex
  ringStart[ringIndex] = pointIndex

  return {
    name: name,
    kind: kind,
    minZoom: minZoom,
    maxZoom: maxZoom,
    featureCount: count,
    coordinates: coordinates,
    ringStart: ringStart,
    featureRing: featureRing,
    bounds: bounds,
    quantum: quantum
  }
}

function decodePlaces(reader, name, kind, minZoom, maxZoom, count, quantum) {
  var places = []
  var x = 0, y = 0
  for (var i = 0; i < count; i++) {
    x += reader.signed()
    y += reader.signed()
    var firstZoom = reader.u8()
    places.push({
      x: x,
      y: y,
      longitude: x / quantum,
      latitude: y / quantum,
      minZoom: firstZoom,
      name: reader.string()
    })
  }
  return {
    name: name,
    kind: kind,
    minZoom: minZoom,
    maxZoom: maxZoom,
    featureCount: count,
    places: places,
    quantum: quantum
  }
}

// ---------------------------------------------------------------------------
// Viewport
// ---------------------------------------------------------------------------

// The geographic window a viewport covers, padded so a line whose endpoints
// are both off-screen still enters the draw list — otherwise a coastline
// crossing the view from edge to edge would vanish at high zoom.
function viewBounds(view) {
  var topLeft = TileMath.unprojectFromViewport(
    0, 0, view.centerLatitude, view.centerLongitude, view.zoom, view.width, view.height)
  var bottomRight = TileMath.unprojectFromViewport(
    view.width, view.height, view.centerLatitude, view.centerLongitude,
    view.zoom, view.width, view.height)

  var padX = (bottomRight.longitude - topLeft.longitude) * 0.1
  var padY = (topLeft.latitude - bottomRight.latitude) * 0.1

  return {
    west: topLeft.longitude - padX,
    east: bottomRight.longitude + padX,
    south: bottomRight.latitude - padY,
    north: topLeft.latitude + padY
  }
}

// Which copies of the world the viewport overlaps.
//
// Web Mercator is a cylinder: pan far enough east and the Pacific gives way to
// Asia again. The radar tiles have always wrapped, because a tile index wraps
// on its own; the ground does not, because it is stored once at real
// longitudes and there is no geometry at 200 degrees east to find. Panning past
// the antimeridian therefore left radar drawn over open sea.
//
// The answer is to draw the same geometry more than once. Each offset is a
// whole world to shift by; at every zoom the map allows, the world is wider
// than the panel, so this returns one copy or two, never more.
function worldOffsets(window) {
  var offsets = []
  var first = Math.floor((window.west + 180) / 360)
  var last = Math.floor((window.east + 180) / 360)
  for (var k = first; k <= last; k++) offsets.push(k)
  return offsets
}

// The same window, moved onto the copy of the world where the geometry lives.
function shiftWindow(window, offset) {
  return {
    west: window.west - offset * 360,
    east: window.east - offset * 360,
    south: window.south,
    north: window.north
  }
}

// The same view, looking at that copy. Projecting stored geometry through this
// puts it on screen where its shifted copy belongs, because the projection is
// linear in longitude.
function shiftView(view, offset) {
  return {
    centerLatitude: view.centerLatitude,
    centerLongitude: view.centerLongitude - offset * 360,
    zoom: view.zoom,
    width: view.width,
    height: view.height
  }
}

function layerAppliesAt(layer, zoom) {
  return !!layer && zoom >= layer.minZoom && zoom <= layer.maxZoom
}

// Indices of the features whose bounding box meets the window. A flat scan:
// the whole world is under 80,000 boxes and four comparisons each, which costs
// less than the branch a spatial index would add to every pan.
function featuresInBounds(layer, window) {
  var found = []
  if (!layer || !layer.bounds) return found

  var quantum = layer.quantum
  var west = window.west * quantum
  var east = window.east * quantum
  var south = window.south * quantum
  var north = window.north * quantum
  var bounds = layer.bounds

  for (var f = 0; f < layer.featureCount; f++) {
    var i = f * 4
    if (bounds[i] > east) continue
    if (bounds[i + 2] < west) continue
    if (bounds[i + 1] > north) continue
    if (bounds[i + 3] < south) continue
    found.push(f)
  }
  return found
}

// Where a point sits relative to the viewport, as a bitmask.
var OUT_LEFT = 1
var OUT_RIGHT = 2
var OUT_TOP = 4
var OUT_BOTTOM = 8

function outcode(x, y, width, height, margin) {
  var code = 0
  if (x < -margin) code |= OUT_LEFT
  else if (x > width + margin) code |= OUT_RIGHT
  if (y < -margin) code |= OUT_TOP
  else if (y > height + margin) code |= OUT_BOTTOM
  return code
}

// One feature's rings, in screen coordinates, reduced two ways.
//
// Thinning drops points closer than `minStep` pixels to the one before. Doing
// it here rather than at build time is what lets one stored geometry serve
// every zoom: the file keeps enough detail for the deepest zoom, and a wide
// view drops the points that would land on top of each other anyway.
//
// Collapsing folds a run of consecutive points that are all outside the same
// edge into a single point. A bounding box that meets the viewport does not
// mean the shape does — a river crossing a continent, or a coastline whose
// interior fills the whole view — and without this the renderer walks and
// draws tens of thousands of points that fall outside the canvas.
//
// Dropping a point replaces two edges with one, and the edge that survives runs
// from the point *before* the dropped one to the point after it. So the test is
// on those two, not on the one being dropped: `anchorCode` is the outcode of
// the second-to-last emitted point, and a point may only be folded into the
// last while it shares an edge with the anchor. Both weaker tests have shipped
// a visible fault here.
//
// Comparing each point only against the one before it lets the shared edge
// drift around a corner — top, then top-and-right, then right — so a polygon
// surrounding the view collapses to a wedge, and its fill covers a diagonal
// band instead of the ground.
//
// Tracking the run's own shared edges but not the anchor's fails on Antarctica,
// whose outline closes by running down the antimeridian to the pole, across the
// bottom of the world and up the other side. The two points at the far corners
// are outside opposite edges, and folding the second into the first draws a
// line straight across the map.
// An edge that runs along the boundary of the projection's domain is not a
// coastline.
//
// A polygon that wraps a pole cannot be drawn on a cylinder without being cut
// open, so Natural Earth closes Antarctica by running down the antimeridian to
// the pole, across the bottom of the world and up the other side. Those edges
// have to be there for the fill to be a closed shape, and drawing them as
// coastline puts a stroke down the middle of the map for anyone who pans to
// the antimeridian at the southern limit.
//
// The domain is longitude +/-180 and, after clamping, latitude +/-85.0511. An
// edge with both ends on one of those lines lies on the cut, not on the ground.
function isDomainEdge(lonA, latA, lonB, latB) {
  if (Math.abs(lonA) >= 180 && Math.abs(lonB) >= 180) return true
  if (latA <= -TileMath.MAX_LATITUDE && latB <= -TileMath.MAX_LATITUDE) return true
  if (latA >= TileMath.MAX_LATITUDE && latB >= TileMath.MAX_LATITUDE) return true
  return false
}

// Whether a feature can contain such an edge at all, from its bounding box.
//
// Almost nothing does: an island has to reach the antimeridian or a pole to be
// cut open. Asking first is what lets the renderer trace a feature once and
// stroke the path it already has, instead of walking every coastline on screen
// a second time for a case that applies to Antarctica and little else.
function featureTouchesDomainEdge(layer, index) {
  if (!layer || !layer.bounds || index < 0 || index >= layer.featureCount) return false
  var i = index * 4
  var quantum = layer.quantum
  if (layer.bounds[i] <= -180 * quantum || layer.bounds[i + 2] >= 180 * quantum) return true
  if (layer.bounds[i + 1] <= -TileMath.MAX_LATITUDE * quantum) return true
  if (layer.bounds[i + 3] >= TileMath.MAX_LATITUDE * quantum) return true
  return false
}

// `breakAtDomainEdge` splits the ring wherever such an edge appears, which is
// what a stroke wants; a fill wants the ring whole and passes it as false.
function featurePaths(layer, index, view, minStep, breakAtDomainEdge) {
  var paths = []
  if (!layer || index < 0 || index >= layer.featureCount) return paths

  var step = minStep === undefined ? 0.7 : minStep
  var quantum = layer.quantum
  var coordinates = layer.coordinates

  var centerX = TileMath.lonToTileX(view.centerLongitude, view.zoom)
  var centerY = TileMath.latToTileY(view.centerLatitude, view.zoom)
  var halfWidth = view.width / 2
  var halfHeight = view.height / 2
  // One tile of slack, so a stroke whose vertex is just off-screen still draws
  // its visible half at the width it should.
  var margin = 256

  var firstRing = layer.featureRing[index]
  var lastRing = layer.featureRing[index + 1]

  for (var r = firstRing; r < lastRing; r++) {
    var from = layer.ringStart[r]
    var to = layer.ringStart[r + 1]
    var path = []
    var previousLon = 0, previousLat = 0
    var lastX = 0, lastY = 0
    // Outcodes of the last two emitted points. Folding is judged against
    // both: the anchor is where the surviving edge starts, and the last is the
    // point about to be dropped.
    var anchorCode = 0
    var lastCode = 0

    for (var p = from; p < to; p++) {
      var lon = coordinates[p * 2] / quantum
      var lat = coordinates[p * 2 + 1] / quantum
      var screenX = halfWidth + (TileMath.lonToTileX(lon, view.zoom) - centerX) * 256
      var screenY = halfHeight + (TileMath.latToTileY(lat, view.zoom) - centerY) * 256
      var code = outcode(screenX, screenY, view.width, view.height, margin)

      if (breakAtDomainEdge && p > from && isDomainEdge(previousLon, previousLat, lon, lat)) {
        if (path.length >= 4) paths.push(path)
        path = []
        anchorCode = 0
        lastCode = 0
      }
      previousLon = lon
      previousLat = lat

      // Always keep the last point of a ring: dropping it would leave a
      // polygon's closing edge cutting across the shape.
      var isLast = !breakAtDomainEdge && p === to - 1

      // Three points outside the same edge reduce to two, because the middle
      // one cannot be seen and the edge between the survivors passes the same
      // side of the viewport. All three have to share the edge: testing only
      // the anchor against the newcomer drops a point that is on screen
      // whenever a ring leaves the viewport, comes back and leaves the same
      // side again — the excursion vanishes, and a feature made of nothing
      // else is not drawn at all.
      if (!isLast && path.length >= 4 && code !== 0 && (anchorCode & lastCode & code) !== 0) {
        path[path.length - 2] = screenX
        path[path.length - 1] = screenY
        lastCode = code
        lastX = screenX
        lastY = screenY
        continue
      }

      if (!isLast && path.length > 0
          && Math.abs(screenX - lastX) < step && Math.abs(screenY - lastY) < step) {
        continue
      }

      path.push(screenX, screenY)
      anchorCode = lastCode
      lastCode = code
      lastX = screenX
      lastY = screenY
    }

    if (path.length >= 4) paths.push(path)
  }

  return paths
}

// ---------------------------------------------------------------------------
// Place labels
// ---------------------------------------------------------------------------

// Which places to draw, and where.
//
// Natural Earth carries a per-place zoom threshold set by cartographers, which
// thins far better than population does: population reads badly in sparsely
// populated regions, where the largest town for 300 km is small in absolute
// terms and is exactly the label somebody needs.
//
// Collision is resolved by taking places in threshold order and refusing any
// whose label box overlaps one already placed, so a dense metropolitan area
// yields its most significant names rather than whichever came first in the
// file.
function placesInView(layer, view, options) {
  var settings = options || {}
  var labelWidth = settings.labelWidth === undefined ? 70 : settings.labelWidth
  var labelHeight = settings.labelHeight === undefined ? 13 : settings.labelHeight
  var limit = settings.limit === undefined ? 60 : settings.limit
  // Natural Earth's thresholds assume a full-screen map; a panel is a fraction
  // of one, so the allowance shifts them to this map's scale.
  var allowance = settings.zoomAllowance === undefined ? 1 : settings.zoomAllowance

  var out = []
  if (!layer || !layer.places) return out

  var window = viewBounds(view)
  var offsets = worldOffsets(window)

  // A place can be a candidate on more than one copy of the world at once, at
  // opposite edges of a view that straddles the antimeridian, so each carries
  // the view it is to be projected through.
  var candidates = []
  for (var o = 0; o < offsets.length; o++) {
    var copyWindow = shiftWindow(window, offsets[o])
    var copyView = shiftView(view, offsets[o])
    for (var i = 0; i < layer.places.length; i++) {
      var place = layer.places[i]
      if (place.longitude < copyWindow.west || place.longitude > copyWindow.east) continue
      if (place.latitude < copyWindow.south || place.latitude > copyWindow.north) continue
      if (place.minZoom > view.zoom + allowance) continue
      candidates.push({ place: place, view: copyView })
    }
  }

  candidates.sort(function(a, b) {
    if (a.place.minZoom !== b.place.minZoom) return a.place.minZoom - b.place.minZoom
    // Longitude breaks ties, so the same view always yields the same labels
    // rather than depending on how the sort happened to run.
    return a.place.x - b.place.x
  })

  for (var c = 0; c < candidates.length && out.length < limit; c++) {
    var candidate = candidates[c].place
    var candidateView = candidates[c].view
    var centerX = TileMath.lonToTileX(candidateView.centerLongitude, candidateView.zoom)
    var centerY = TileMath.latToTileY(candidateView.centerLatitude, candidateView.zoom)
    var x = view.width / 2 + (TileMath.lonToTileX(candidate.longitude, view.zoom) - centerX) * 256
    var y = view.height / 2 + (TileMath.latToTileY(candidate.latitude, view.zoom) - centerY) * 256
    if (x < 0 || x > view.width || y < 0 || y > view.height) continue

    var clash = false
    for (var o = 0; o < out.length; o++) {
      if (Math.abs(x - out[o].x) < labelWidth && Math.abs(y - out[o].y) < labelHeight) {
        clash = true
        break
      }
    }
    if (clash) continue

    out.push({ x: x, y: y, name: candidate.name, minZoom: candidate.minZoom })
  }

  return out
}
