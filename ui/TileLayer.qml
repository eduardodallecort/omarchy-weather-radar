import QtQuick
import "../lib/TileMath.js" as TileMath

// One raster layer of an XYZ tile map.
//
// RadarMap stacks two of these, one per radar frame, over the ground that
// BasemapLayer draws. The geometry lives here rather than up there because
// every layer has to share a centre and zoom: any drift between them would
// show up as the rain sitting next to the coastline instead of on it.
//
// Tiles are plain Image elements, loaded from wherever the owner says. For the
// radar that is the service's copy on disk rather than the network: Qt keeps
// only a few megabytes of images nothing is drawing, far less than one pass
// through the loop, so it cannot be what makes the second pass free.
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

  // function(zoom, x, y) -> the tile's URL, "" for a tile with nothing to
  // draw, or null for one that is on its way but cannot be loaded yet. A null
  // tile draws nothing, like "", but counts as outstanding until it arrives.
  property var tileUrlFor: null

  // Changed by the owner whenever the tiles it would ask for change (a new
  // frame, a different palette), so bindings re-evaluate; any value, only its
  // changes matter. It is read by each tile's source binding rather than by
  // the model below: a new frame must repoint the tiles, not tear the whole
  // grid down and build it again.
  property var revision: 0

  // Tiles not on screen yet, whether still loading or not yet loadable. Zero
  // means every tile this layer wants is drawn, which is what lets the owner
  // hold a crossfade back until the incoming frame is actually there to fade
  // to.
  property int pendingTiles: 0
  readonly property bool contentReady: pendingTiles <= 0

  property int tileSize: 256
  property bool smooth: true

  // A tile that could not be loaded, with the source it was loaded from.
  signal tileFailed(string source)

  clip: true

  // Laid out in source-zoom space, then scaled onto the screen. Passing the
  // viewport through sourceScale is what lets one upscaled tile cover the area
  // several native-zoom tiles would have.
  readonly property var layout: TileMath.viewportTiles(
    centerLatitude, centerLongitude, sourceZoom,
    Math.max(1, width / sourceScale), Math.max(1, height / sourceScale))

  // Flattened tile list. Rebuilt whenever the viewport moves — but not when the
  // frame changes, which only repoints the tiles that are already there. At the zoom
  // levels this plugin uses that is a few dozen entries, so the simple
  // approach beats an incremental one for readability.
  readonly property var tiles: {
    var list = []
    var view = layout
    if (!view || width <= 0 || height <= 0) return list
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

      readonly property var target: {
        // Read so a new frame or palette repoints this tile in place.
        var unused = root.revision
        return root.tileUrlFor ? root.tileUrlFor(root.sourceZoom, modelData.tileX, modelData.tileY) : ""
      }
      readonly property bool awaiting: target === null
      source: awaiting ? "" : target
      asynchronous: true
      cache: true
      // The loader is asked for a tile-sized surface rather than whatever the
      // response turns out to declare. Every other stream that reaches this
      // process carries a ceiling; an image arriving over the network is one
      // too, and its size is decided by whoever served it.
      sourceSize: Qt.size(root.tileSize, root.tileSize)
      // Upscaled tiles need the smoothing; native-resolution ones look
      // sharper without it.
      smooth: root.smooth || root.sourceScale > 1
      fillMode: Image.Stretch

      // A tile that has not arrived stays invisible rather than showing a
      // placeholder, which would read as a rendering fault. Nothing is drawn
      // for a tile with no data either, but that arrives as a transparent
      // image rather than as an error.
      visible: status === Image.Ready
      onStatusChanged: if (status === Image.Error) root.tileFailed(String(source))

      // Each tile reports only its own state, adding one to the layer's count
      // while it is outstanding and taking it away once it settles. Counting
      // that way survives tiles being created and destroyed under a pan
      // without the layer ever having to recount them.
      //
      // `counted` is what makes it exact. The change handler also runs when
      // the binding is first evaluated, so a tile born settled — no source
      // yet, or a cached pixmap that is ready at once — would otherwise take
      // away one it never added, and the layer would read as ready while its
      // tiles were still loading.
      readonly property bool settled: !awaiting
        && (source == "" || status === Image.Ready || status === Image.Error)
      property bool counted: false
      function recount() {
        if (counted === !settled) return
        counted = !settled
        root.pendingTiles += counted ? 1 : -1
      }
      onSettledChanged: recount()
      Component.onCompleted: recount()
      Component.onDestruction: if (counted) root.pendingTiles--
    }
  }
}
