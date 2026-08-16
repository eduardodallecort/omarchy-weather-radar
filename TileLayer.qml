import QtQuick
import "TileMath.js" as TileMath

// One raster layer of an XYZ tile map.
//
// The panel stacks these — a basemap and the radar frames on top — which is why
// the geometry lives here instead of in the panel: every layer shares a centre
// and zoom, and any drift between them would show up as the rain sitting next
// to the coastline instead of on it.
//
// Tiles are plain Image elements. Qt's pixmap cache keys on URL, and RainViewer
// tile URLs are immutable per frame, so scrubbing back through the loop or
// panning to somewhere already visited costs nothing the second time.
Item {
  id: root

  property real centerLatitude: 0
  property real centerLongitude: 0

  // Zoom of the viewport — the scale the user sees.
  property int zoom: 7

  // Zoom the tiles are actually requested at. Normally identical, but a layer
  // whose source runs out of resolution before the map does keeps asking for
  // its deepest real tiles and scales them up. Radar stops at z7 while the
  // basemap goes far deeper, and capping the whole map at the radar's limit
  // would be the wrong trade: people zoom in to see which town is under a
  // storm, and the town comes from the basemap.
  property int sourceZoom: zoom

  readonly property real sourceScale: Math.pow(2, zoom - sourceZoom)

  // function(zoom, x, y) -> string. Returning "" skips the tile, which is how
  // a layer stays blank until its data is ready.
  property var tileUrlFor: null

  // Bumped by the owner to force a reload when the URL scheme itself changes
  // (a new frame, a different palette) so bindings re-evaluate.
  property int revision: 0

  property int tileSize: 256
  property bool smooth: true

  signal tileFailed()

  clip: true

  // Laid out in source-zoom space, then scaled onto the screen. Passing the
  // viewport through sourceScale is what lets one upscaled tile cover the area
  // several native-zoom tiles would have.
  readonly property var layout: TileMath.viewportTiles(
    centerLatitude, centerLongitude, sourceZoom,
    Math.max(1, width / sourceScale), Math.max(1, height / sourceScale))

  // Flattened tile list. Rebuilt whenever the viewport moves; at the zoom
  // levels this plugin uses that is a few dozen entries, so the simple
  // approach beats an incremental one for readability.
  readonly property var tiles: {
    var list = []
    var view = layout
    if (!view || width <= 0 || height <= 0) return list
    // `revision` is read so the model rebuilds when the frame changes.
    var unused = revision
    var scale = sourceScale
    for (var y = view.minY; y <= view.maxY; y++) {
      if (!TileMath.isValidTileY(y, sourceZoom)) continue
      for (var x = view.minX; x <= view.maxX; x++) {
        list.push({
          tileX: TileMath.wrapTileX(x, sourceZoom),
          tileY: y,
          screenX: (view.originX + (x - view.minX) * root.tileSize) * scale,
          screenY: (view.originY + (y - view.minY) * root.tileSize) * scale
        })
      }
    }
    return list
  }

  Repeater {
    model: root.tiles

    Image {
      required property var modelData

      x: modelData.screenX
      y: modelData.screenY
      width: root.tileSize * root.sourceScale
      height: root.tileSize * root.sourceScale

      source: root.tileUrlFor ? root.tileUrlFor(root.sourceZoom, modelData.tileX, modelData.tileY) : ""
      asynchronous: true
      cache: true
      // Upscaled tiles need the smoothing; native-resolution ones look
      // sharper without it.
      smooth: root.smooth || root.sourceScale > 1
      fillMode: Image.Stretch

      // A missing tile is normal at the edges of coverage and must not look
      // like a rendering fault, so it simply stays invisible.
      visible: status === Image.Ready
      onStatusChanged: if (status === Image.Error) root.tileFailed()
    }
  }
}
