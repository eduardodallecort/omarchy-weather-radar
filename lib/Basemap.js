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
// into parallel typed arrays rather than nested structures, because the
// renderer walks them on every pan and the cost of a million small objects is
// paid in garbage collection during a drag.
//
// The format is written by tools/build-basemap.py and described there.

.pragma library

.import "TileMath.js" as TileMath

var MAGIC = "OWRB"
var FORMAT_VERSION = 2

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

// Decoding is resumable, because it runs on the thread that draws the bar,
// every panel and the lock screen. Read in one call, the shipped file holds
// that thread for over half a second on a fast laptop and for several on a
// slow one — the algorithm is quick, at around 60 ms in node, but the QML
// engine runs it nine times slower, and no decoder written differently would
// change that. So the work is cut into steps of DECODE_STEP_MS, and the
// caller drives them from a timer, giving the frame back between steps.
//
// A step stops between two points, not just between features: a continent's
// outline is fifty thousand points, which is a step in itself.
//
// Each layer's header states how many rings and points it holds, so every
// array is allocated once at the right size and the data is read exactly once.
// Growing arrays instead would copy several megabytes repeatedly.

// How long one step may hold the thread. The shell takes one step per frame,
// so eight milliseconds leaves half of a 60 Hz frame for the panel's own
// animation and whatever else the shell is doing, at the cost of the ground
// arriving over a second or so instead of at once — a second in which the
// radar is already drawn over open sea.
var DECODE_STEP_MS = 8

// Points per run of ring bounds. See featurePaths for what the bounds buy.
var CHUNK = 32

// How far outside the canvas a point still counts as on it, in pixels. A
// vertex just past the edge has a line join that can reach back in by half
// the stroke's width, and the widest stroke drawn is a pixel; four is that
// with room. Everything beyond is invisible, and is folded or skipped.
var PATH_MARGIN = 4

// Points decoded between two looks at the clock. The look is cheap but not
// free, and 512 points is well under a millisecond of work. A step always
// decodes at least this much before it looks, so that every step makes
// progress whatever its budget.
var CLOCK_EVERY = 512

// Returns null rather than throwing on anything unreadable. A basemap that
// fails to load leaves the radar drawn over an empty ground, which is a
// degraded map; an exception during startup is a broken shell.
//
// Reads the whole file in one call. The shell drives a Decoder step by step
// instead; this is the form the tests and the tools use.
function decode(buffer) {
  var decoder = beginDecode(buffer)
  if (!decoder) return null
  while (!decoder.step(Infinity)) {}
  return decoder.result
}

// A decoder positioned after the file header, or null if there is no header
// to read. From here, `step()` until it answers true, then read `result`.
function beginDecode(buffer) {
  if (!buffer || !buffer.byteLength) return null
  try {
    return new Decoder(buffer)
  } catch (e) {
    return null
  }
}

function Decoder(buffer) {
  this.reader = new Reader(buffer)

  var magic = ""
  for (var m = 0; m < 4; m++) magic += String.fromCharCode(this.reader.u8())
  if (magic !== MAGIC) throw new Error("basemap: not a basemap")
  if (this.reader.u8() !== FORMAT_VERSION) throw new Error("basemap: unknown format version")

  this.quantum = this.reader.varint()
  if (!(this.quantum > 0)) throw new Error("basemap: quantum must be positive")

  // Layers still to read, then the ones finished so far, in file order.
  this.remaining = this.reader.varint()
  this.layers = {}
  this.order = []

  // The layer being read and where inside it the last step stopped.
  this.layer = null
  this.cursor = null

  // Set once, when the last layer is closed or the file turns out to be
  // unreadable. `result` is the basemap, or null.
  this.finished = false
  this.result = null
}

// Decodes for up to `budgetMs`. Answers true once there is nothing left to do,
// whether the file decoded or not — a truncated or corrupt file ends with
// `result` null, and never with an exception, however far in it failed.
Decoder.prototype.step = function(budgetMs) {
  if (this.finished) return true
  var deadline = Date.now() + budgetMs

  try {
    while (this.remaining > 0) {
      if (this.layer === null) this.openLayer()
      var complete = this.layer.kind === POINTS
        ? this.readPlaces(deadline)
        : this.readGeometry(deadline)
      if (!complete) return false
      this.closeLayer()
    }
    this.result = { quantum: this.quantum, layers: this.layers, order: this.order }
  } catch (e) {
    this.result = null
  }

  this.finished = true
  return true
}

// The layers finished so far, as a basemap the renderer can draw. Each is
// complete and never changes again, so the ground can be shown as it arrives:
// land first, then what sits on it.
Decoder.prototype.partial = function() {
  var layers = {}
  for (var i = 0; i < this.order.length; i++) layers[this.order[i]] = this.layers[this.order[i]]
  return { quantum: this.quantum, layers: layers, order: this.order.slice() }
}

Decoder.prototype.openLayer = function() {
  var reader = this.reader
  var layer = {
    name: reader.string(),
    kind: reader.u8(),
    minZoom: reader.u8(),
    maxZoom: reader.u8(),
    featureCount: reader.varint(),
    quantum: this.quantum
  }

  if (layer.kind === POINTS) {
    layer.places = []
    this.layer = layer
    this.cursor = { i: 0, x: 0, y: 0 }
    return
  }

  var ringTotal = reader.varint()
  var pointTotal = reader.varint()

  // The totals size the arrays, so they are checked against the only thing
  // that bounds them: the bytes left in the file. A feature, a ring and a
  // point each cost at least one byte — a point two — so a header claiming
  // more than that is lying, and would otherwise allocate whatever it asked
  // for before the first read failed.
  var left = reader.end - reader.at
  if (layer.featureCount > left || ringTotal > left || pointTotal * 2 > left) {
    throw new Error("basemap: layer claims more than the file holds")
  }

  layer.coordinates = new Int32Array(pointTotal * 2)
  layer.ringStart = new Int32Array(ringTotal + 1)
  layer.featureRing = new Int32Array(layer.featureCount + 1)
  layer.bounds = new Int32Array(layer.featureCount * 4)
  layer.ringChunk = new Int32Array(ringTotal + 1)
  // At most one partial run per ring, and the rest full.
  layer.chunkBounds = new Int32Array((Math.floor(pointTotal / CHUNK) + ringTotal) * 4)
  layer.chunkCount = 0

  this.layer = layer
  this.cursor = {
    ringTotal: ringTotal,
    pointTotal: pointTotal,
    // Positions in the arrays above.
    feature: 0, ring: 0, point: 0, chunk: 0,
    // Inside the current feature and ring. `ringsLeft` is -1 until the
    // feature's own header has been read; `inRing` says whether the ring's
    // has.
    ringsLeft: -1, pointsLeft: 0, inRing: false,
    // Deltas accumulate from the start of each ring.
    x: 0, y: 0,
    // Bounds of the feature so far, and of the run of points so far.
    minX: 0, minY: 0, maxX: 0, maxY: 0,
    runMinX: 0, runMinY: 0, runMaxX: 0, runMaxY: 0, runLength: 0
  }
}

Decoder.prototype.closeLayer = function() {
  var layer = this.layer
  if (layer.kind !== POINTS) {
    var cursor = this.cursor
    if (cursor.ring !== cursor.ringTotal || cursor.point !== cursor.pointTotal) {
      throw new Error("basemap: layer holds other than it claims")
    }
    layer.featureRing[cursor.feature] = cursor.ring
    layer.ringStart[cursor.ring] = cursor.point
    layer.ringChunk[cursor.ring] = cursor.chunk
    layer.chunkBounds = layer.chunkBounds.slice(0, cursor.chunk * 4)
    layer.chunkCount = cursor.chunk
  }

  this.layers[layer.name] = layer
  this.order.push(layer.name)
  this.remaining--
  this.layer = null
  this.cursor = null
}

// Reads points until the layer is complete (true) or the deadline passes
// (false). The state lives in locals while this runs and in the cursor
// between runs — a property write per point would cost more than the decoding.
Decoder.prototype.readGeometry = function(deadline) {
  var reader = this.reader
  var layer = this.layer
  var c = this.cursor

  var coordinates = layer.coordinates
  var ringStart = layer.ringStart
  var featureRing = layer.featureRing
  var bounds = layer.bounds
  var ringChunk = layer.ringChunk
  var chunkBounds = layer.chunkBounds
  var featureCount = layer.featureCount

  var feature = c.feature, ring = c.ring, point = c.point, chunk = c.chunk
  var entryPoint = point
  var ringsLeft = c.ringsLeft, pointsLeft = c.pointsLeft, inRing = c.inRing
  var x = c.x, y = c.y
  var minX = c.minX, minY = c.minY, maxX = c.maxX, maxY = c.maxY
  var runMinX = c.runMinX, runMinY = c.runMinY, runMaxX = c.runMaxX, runMaxY = c.runMaxY
  var runLength = c.runLength

  while (feature < featureCount) {
    if (ringsLeft < 0) {
      featureRing[feature] = ring
      ringsLeft = reader.varint()
      if (ringsLeft > c.ringTotal - ring) throw new Error("basemap: more rings than declared")
      minX = 2147483647; minY = 2147483647
      maxX = -2147483648; maxY = -2147483648
    }

    while (ringsLeft > 0) {
      if (!inRing) {
        ringStart[ring] = point
        ringChunk[ring] = chunk
        pointsLeft = reader.varint()
        if (pointsLeft > c.pointTotal - point) throw new Error("basemap: more points than declared")
        x = 0; y = 0
        runMinX = 2147483647; runMinY = 2147483647
        runMaxX = -2147483648; runMaxY = -2147483648
        runLength = 0
        inRing = true
      }

      while (pointsLeft > 0) {
        if (point !== entryPoint && (point % CLOCK_EVERY) === 0 && Date.now() >= deadline) {
          c.feature = feature; c.ring = ring; c.point = point; c.chunk = chunk
          c.ringsLeft = ringsLeft; c.pointsLeft = pointsLeft; c.inRing = inRing
          c.x = x; c.y = y
          c.minX = minX; c.minY = minY; c.maxX = maxX; c.maxY = maxY
          c.runMinX = runMinX; c.runMinY = runMinY; c.runMaxX = runMaxX; c.runMaxY = runMaxY
          c.runLength = runLength
          return false
        }

        x += reader.signed()
        y += reader.signed()
        coordinates[point * 2] = x
        coordinates[point * 2 + 1] = y
        point++
        pointsLeft--

        if (x < runMinX) runMinX = x
        if (x > runMaxX) runMaxX = x
        if (y < runMinY) runMinY = y
        if (y > runMaxY) runMaxY = y
        runLength++

        if (runLength === CHUNK || pointsLeft === 0) {
          chunkBounds[chunk * 4] = runMinX
          chunkBounds[chunk * 4 + 1] = runMinY
          chunkBounds[chunk * 4 + 2] = runMaxX
          chunkBounds[chunk * 4 + 3] = runMaxY
          chunk++
          if (runMinX < minX) minX = runMinX
          if (runMaxX > maxX) maxX = runMaxX
          if (runMinY < minY) minY = runMinY
          if (runMaxY > maxY) maxY = runMaxY
          runMinX = 2147483647; runMinY = 2147483647
          runMaxX = -2147483648; runMaxY = -2147483648
          runLength = 0
        }
      }

      ring++
      ringsLeft--
      inRing = false
    }

    bounds[feature * 4] = minX
    bounds[feature * 4 + 1] = minY
    bounds[feature * 4 + 2] = maxX
    bounds[feature * 4 + 3] = maxY
    feature++
    ringsLeft = -1
  }

  c.feature = feature; c.ring = ring; c.point = point; c.chunk = chunk
  return true
}

Decoder.prototype.readPlaces = function(deadline) {
  var reader = this.reader
  var layer = this.layer
  var c = this.cursor
  var quantum = this.quantum
  var places = layer.places
  var x = c.x, y = c.y

  for (var i = c.i; i < layer.featureCount; i++) {
    if (i !== c.i && (i % 64) === 0 && Date.now() >= deadline) {
      c.i = i; c.x = x; c.y = y
      return false
    }
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
  return true
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
// the whole world is some 83,000 boxes and four comparisons each, about a
// millisecond under the QML engine — less than the branch a spatial index
// would add to every pan.
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

// The ground the margin-extended viewport covers, in the file's own units, so
// a run of stored points can be judged against it without projecting them.
//
// Projection is monotonic in each axis — longitude only ever moves a point
// right, latitude only ever moves it up — so a run whose box lies wholly
// beyond one edge here lies wholly beyond that edge on screen. The vertical
// edges are the exception where the viewport reaches past the projection's
// own limit: every latitude beyond +/-85.0511 is clamped onto that limit, so
// nothing can be above a top edge that is itself above the world. Those edges
// are marked as unreachable rather than given a latitude.
function paintWindow(view, quantum, margin) {
  var zoom = view.zoom
  var centerX = TileMath.lonToTileX(view.centerLongitude, zoom)
  var centerY = TileMath.latToTileY(view.centerLatitude, zoom)
  var halfWidth = (view.width / 2 + margin) / 256
  var halfHeight = (view.height / 2 + margin) / 256
  var top = centerY - halfHeight
  var bottom = centerY + halfHeight
  var world = Math.pow(2, zoom)
  return {
    west: TileMath.tileXToLon(centerX - halfWidth, zoom) * quantum,
    east: TileMath.tileXToLon(centerX + halfWidth, zoom) * quantum,
    north: top <= 0 ? Infinity : TileMath.tileYToLat(top, zoom) * quantum,
    south: bottom >= world ? -Infinity : TileMath.tileYToLat(bottom, zoom) * quantum
  }
}

// Whether every point of a run is beyond the same edge of the window.
function runBeyondEdge(chunkBounds, chunk, window) {
  var i = chunk * 4
  return chunkBounds[i + 2] < window.west
    || chunkBounds[i] > window.east
    || chunkBounds[i + 3] < window.south
    || chunkBounds[i + 1] > window.north
}

// `breakAtDomainEdge` splits the ring wherever such an edge appears, which is
// what a stroke wants; a fill wants the ring whole and passes it as false.
//
// A ring is walked in runs of CHUNK points, and a run that lies wholly beyond
// one edge of the viewport is not walked at all: only its first and last
// points go through, joined by a straight edge. That edge and the points it
// replaces are all beyond the same side of the canvas, and the region between
// the two is beyond it as well — a half-plane holds every segment between
// two of its points — so nothing visible changes, for a fill or a stroke.
//
// Without this, the cost of a view is the size of whatever touches it rather
// than the size of what it shows. The Americas are one polygon of fifty
// thousand points whose box runs from the Aleutians to Cape Horn, and a view
// of open Pacific inside that box walked every one of them to draw twenty. The
// bounds of each run are computed while decoding, so the decision costs four
// comparisons against numbers the file already holds.
//
// The same holds when the ring is being cut at the projection's domain: a cut
// inside a skipped run would only have removed an edge nobody can see.
function featurePaths(layer, index, view, minStep, breakAtDomainEdge) {
  var paths = []
  if (!layer || index < 0 || index >= layer.featureCount) return paths

  var step = minStep === undefined ? 0.7 : minStep
  var quantum = layer.quantum
  var coordinates = layer.coordinates
  var ringChunk = layer.ringChunk
  var chunkBounds = layer.chunkBounds

  var margin = PATH_MARGIN

  // The projection, reduced to what it is per point: a multiply for x, and a
  // log of a tan for y, against constants of the view. This is the same Web
  // Mercator as TileMath, in a form that makes no calls — under the QML
  // engine the two calls it would otherwise make per point cost more than
  // everything else in the walk put together.
  var scale = Math.pow(2, view.zoom) * 256
  var originX = view.width / 2 - TileMath.lonToTileX(view.centerLongitude, view.zoom) * 256 + scale / 2
  var xPerUnit = scale / 360 / quantum
  var originY = view.height / 2 - TileMath.latToTileY(view.centerLatitude, view.zoom) * 256 + scale / 2
  var yPerRadian = -scale / (2 * Math.PI)
  var halfRadianPerUnit = Math.PI / 360 / quantum
  var maxLatitude = TileMath.MAX_LATITUDE * quantum

  var firstRing = layer.featureRing[index]
  var lastRing = layer.featureRing[index + 1]

  // Only a feature with runs to skip needs the window they are judged
  // against; most features are a single run, and pay nothing for it.
  var window = ringChunk[lastRing] - ringChunk[firstRing] > 1
    ? paintWindow(view, quantum, margin)
    : null

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

    var firstChunk = ringChunk[r]
    var lastChunk = ringChunk[r + 1]

    for (var chunk = firstChunk; chunk < lastChunk; chunk++) {
      var runFrom = from + (chunk - firstChunk) * CHUNK
      var runTo = Math.min(runFrom + CHUNK, to)
      var skip = window !== null && runBeyondEdge(chunkBounds, chunk, window)

      for (var p = runFrom; p < runTo; p++) {
        // A skipped run is its first point and its last, and nothing between.
        if (skip && p > runFrom) p = runTo - 1

        var x = coordinates[p * 2]
        var y = coordinates[p * 2 + 1]
        // Latitudes past the projection's limit sit on it, as in TileMath.
        if (y > maxLatitude) y = maxLatitude
        else if (y < -maxLatitude) y = -maxLatitude
        var screenX = originX + x * xPerUnit
        var screenY = originY + Math.log(Math.tan(Math.PI / 4 + y * halfRadianPerUnit)) * yPerRadian
        var code = outcode(screenX, screenY, view.width, view.height, margin)
        var lon = x / quantum
        var lat = coordinates[p * 2 + 1] / quantum

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
