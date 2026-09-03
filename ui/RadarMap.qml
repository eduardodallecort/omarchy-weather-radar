import QtQuick
import qs.Commons
import qs.Ui
import "../lib/Glyphs.js" as Glyphs
import "../lib/RadarModel.js" as RadarModel
import "../lib/TileMath.js" as TileMath

// The map itself: a basemap, the radar frames stacked over it, the alert rings
// around home, and the drag and wheel gestures that move the view.
//
// The panel owns the view — where it is centred and how far in it is zoomed —
// because the keyboard shortcuts and the recentre button move it too. This
// renders that view and reports the gestures made on it.
Item {
  id: root

  property var bar: null

  // The decoded ground, owned by the service. Null until its first layer has
  // been decoded, then filled in layer by layer over a second or so — the
  // map is open sea for a moment, then land, then what sits on it.
  property var basemap: null

  // Where the map is looking.
  property real centerLatitude: 0
  property real centerLongitude: 0
  property int zoom: 7

  // The zoom the radar layers request. Radar resolution runs out before the
  // map does, so past that limit they keep asking for their deepest real tiles
  // and get scaled up over a basemap that is still sharpening.
  property int radarSourceZoom: zoom

  // function(zoom, x, y) -> string, one per radar layer. See RadarModel.
  property var radarTileUrlA: null
  property var radarTileUrlB: null

  // The frame after the one coming in, fetched into a layer nobody sees so
  // that it is in the pixmap cache before the loop asks for it. Without it the
  // first pass through a loop is the only one that stutters, which is still
  // the pass someone watches with the panel newly open.
  property int prefetchFrame: -1
  property var radarTileUrlPrefetch: null

  // Which of the two radar layers holds which frame, and which is in front.
  // Bumping a layer's frame while it is behind, then swapping, is what makes
  // the loop dissolve instead of flicker.
  property int frameA: -1
  property int frameB: -1
  property bool frontIsA: true

  // The swap the panel has asked for, and the one actually on screen. They
  // differ while the incoming layer is still fetching its tiles: fading to a
  // layer that has not arrived is what a flicker is, so the request is held
  // until the tiles are there. Held, not dropped — a layer that never
  // completes, because the network is down or a tile 404s past the edge of
  // coverage, still has to give way, so the fallback below swaps regardless.
  property bool showA: true
  readonly property var incomingLayer: frontIsA ? radarA : radarB

  // Deferred, not immediate: the frame is written into the layer behind and the
  // swap asked for in the same pass, and read at that moment the layer still
  // reports the tiles it held before its sources were repointed. One turn of
  // the loop later it reports the ones it is actually fetching.
  onFrontIsAChanged: Qt.callLater(root.applySwapWhenReady)

  function applySwapWhenReady() {
    if (showA === frontIsA) return
    if (incomingLayer.contentReady) {
      swapFallback.stop()
      showA = frontIsA
    } else if (!swapFallback.running) {
      swapFallback.restart()
    }
  }

  Timer {
    id: swapFallback
    // Shorter than the shortest playback step, so a layer that will not finish
    // loading costs the loop a frame's worth of delay rather than stalling it.
    interval: 500
    onTriggered: root.showA = root.frontIsA
  }

  // Changes when the frame list is replaced. Folded into each layer's revision
  // so that a new manifest reloads the tiles even when the index did not move.
  property int frameEpoch: 0
  property int colorSchemeId: 2
  property bool smoothTiles: true

  // Home, and the rings around it.
  property bool hasLocation: false
  property real homeLatitude: 0
  property real homeLongitude: 0
  property bool alertsEnabled: false
  property int alertRadiusKm: 100

  // Shown until the first manifest arrives, so an empty map during the first
  // second does not read as "no rain".
  property bool loading: false

  // Whether the frame list is absent because fetching it failed rather than
  // because it has not arrived yet. An empty map that says it is loading, for
  // as long as the network is down, is the wrong half of that.
  //
  // Only the list. Whether the tiles under it can be fetched is deliberately
  // not reported: the layers cache by URL, so a map holding frames it fetched
  // before goes on drawing them with no network at all — correctly, and with
  // the frame's own time under it. Counting tile errors flagged that healthy
  // case as an outage while missing the one it was written for.
  property bool radarUnavailable: false

  property string attribution: ""

  signal dragged(real latitude, real longitude)
  signal recenterRequested()

  // Zooming carries a centre because the wheel zooms towards the pointer, not
  // towards the middle of the map. Someone reaching for a coastal town does
  // not want the sea their view happens to be centred on.
  signal zoomRequested(int zoom, real latitude, real longitude)

  readonly property color foreground: bar ? bar.foreground : Color.foreground

  Rectangle {
    id: canvasFrame
    anchors.fill: parent
    // The same tone the ground layer paints its sea with, so the corners it
    // cannot reach match rather than showing through as a hole.
    color: ground.seaColor
    radius: Style.cornerRadius
    clip: true

    BasemapLayer {
      id: ground
      anchors.fill: parent
      basemap: root.basemap
      centerLatitude: root.centerLatitude
      centerLongitude: root.centerLongitude
      zoom: root.zoom
    }

    // Fetches, draws nothing. An Image loads its source whether or not the item
    // it belongs to is painted, which is the whole trick here.
    TileLayer {
      id: radarPrefetch
      anchors.fill: parent
      centerLatitude: root.centerLatitude
      centerLongitude: root.centerLongitude
      zoom: root.zoom
      sourceZoom: root.radarSourceZoom
      tileUrlFor: root.radarTileUrlPrefetch
      revision: root.prefetchFrame + (root.colorSchemeId * 1000) + (root.frameEpoch * 100000)
      smooth: root.smoothTiles
      opacity: 0
    }

    TileLayer {
      id: radarA
      anchors.fill: parent
      centerLatitude: root.centerLatitude
      centerLongitude: root.centerLongitude
      zoom: root.zoom
      sourceZoom: root.radarSourceZoom
      tileUrlFor: root.radarTileUrlA
      revision: root.frameA + (root.colorSchemeId * 1000) + (root.frameEpoch * 100000)
      smooth: root.smoothTiles
      opacity: root.showA ? 1 : 0
      onContentReadyChanged: root.applySwapWhenReady()
      Behavior on opacity {
        NumberAnimation { duration: 380; easing.type: Easing.InOutQuad }
      }
    }

    TileLayer {
      id: radarB
      anchors.fill: parent
      centerLatitude: root.centerLatitude
      centerLongitude: root.centerLongitude
      zoom: root.zoom
      sourceZoom: root.radarSourceZoom
      tileUrlFor: root.radarTileUrlB
      revision: root.frameB + (root.colorSchemeId * 1000) + (root.frameEpoch * 100000)
      smooth: root.smoothTiles
      opacity: !root.showA ? 1 : 0
      onContentReadyChanged: root.applySwapWhenReady()
      Behavior on opacity {
        NumberAnimation { duration: 380; easing.type: Easing.InOutQuad }
      }
    }

    // ---- Alert rings and home marker ------------------------------------
    Item {
      id: homeOverlay
      anchors.fill: parent
      visible: root.hasLocation

      // The copy of home nearest the centre. Two points either side of the
      // antimeridian are a couple of degrees apart on the globe and 358 apart
      // in their coordinates, so without this a map centred just east of the
      // line puts the marker most of a world away.
      readonly property var home: TileMath.projectToViewport(
        root.homeLatitude,
        TileMath.nearestLongitude(root.homeLongitude, root.centerLongitude),
        root.centerLatitude, root.centerLongitude,
        root.zoom, width, height)

      readonly property real ringRadius: TileMath.kmToPixels(
        root.alertRadiusKm, root.homeLatitude, root.zoom)

      // Outer ring is the configured alert radius; the inner half-ring gives a
      // sense of scale.
      Repeater {
        model: [0.5, 1.0]

        Rectangle {
          required property real modelData
          readonly property real r: homeOverlay.ringRadius * modelData
          x: homeOverlay.home.x - r
          y: homeOverlay.home.y - r
          width: r * 2
          height: r * 2
          radius: r
          color: "transparent"
          border.color: Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b,
            modelData === 1.0 ? 0.55 : 0.3)
          border.width: 1
          visible: root.alertsEnabled && r > 6 && r < homeOverlay.width * 2
        }
      }

      Rectangle {
        readonly property real dot: Style.space(7)
        x: homeOverlay.home.x - dot / 2
        y: homeOverlay.home.y - dot / 2
        width: dot
        height: dot
        radius: dot / 2
        color: Color.accent
        // Outlined in the surface's own colour so the marker stays legible
        // over a dark coastline and a light one alike.
        border.color: Color.popups.background
        border.width: 1
      }
    }

    // ---- Pan and zoom ---------------------------------------------------
    MouseArea {
      anchors.fill: parent
      acceptedButtons: Qt.LeftButton
      cursorShape: pressed ? Qt.ClosedHandCursor : Qt.OpenHandCursor

      property real lastX: 0
      property real lastY: 0

      onPressed: function(mouse) {
        lastX = mouse.x
        lastY = mouse.y
      }

      onPositionChanged: function(mouse) {
        if (!pressed) return
        var dx = mouse.x - lastX
        var dy = mouse.y - lastY
        if (dx === 0 && dy === 0) return
        lastX = mouse.x
        lastY = mouse.y

        // Convert the drag into a new centre by asking which coordinate now
        // sits under the middle of the viewport.
        var moved = TileMath.unprojectFromViewport(
          width / 2 - dx, height / 2 - dy,
          root.centerLatitude, root.centerLongitude,
          root.zoom, width, height)
        root.dragged(moved.latitude, moved.longitude)
      }

      onWheel: function(wheel) {
        wheel.accepted = true

        var direction = wheel.angleDelta.y > 0 ? 1 : -1
        var next = Math.max(RadarModel.MIN_RADAR_ZOOM,
          Math.min(RadarModel.MAX_MAP_ZOOM, root.zoom + direction))
        if (next === root.zoom) return

        // Which coordinate is under the pointer now, and where the map has to
        // be centred for it to still be under the pointer afterwards.
        var anchor = TileMath.unprojectFromViewport(
          wheel.x, wheel.y, root.centerLatitude, root.centerLongitude,
          root.zoom, width, height)
        var moved = TileMath.centerForPoint(
          anchor.latitude, anchor.longitude, wheel.x, wheel.y, next, width, height)

        root.zoomRequested(next, moved.latitude, moved.longitude)
      }
    }

    // ---- Overlays -------------------------------------------------------
    // The same affordance every map has, because the keyboard shortcut for it
    // is not discoverable and someone who has panned away has no other way
    // back short of retyping their city.
    Button {
      anchors.left: parent.left
      anchors.bottom: parent.bottom
      anchors.margins: Style.space(6)
      visible: root.hasLocation
      text: Glyphs.RECENTER
      fontFamily: Style.font.family
      foreground: root.foreground
      background: Color.popups.background
      bordered: true
      tooltipText: "Centre on your location (Home)"
      onClicked: root.recenterRequested()
    }

    Text {
      textFormat: Text.PlainText
      anchors.right: parent.right
      anchors.bottom: parent.bottom
      anchors.margins: Style.space(6)
      text: root.attribution
      color: root.foreground
      font.family: Style.font.family
      font.pixelSize: Style.font.caption * 0.8
      opacity: 0.4
    }

    Text {
      textFormat: Text.PlainText
      anchors.centerIn: parent
      visible: root.loading
      text: root.radarUnavailable ? "Radar unavailable" : "Loading radar…"
      color: root.foreground
      font.family: Style.font.family
      font.pixelSize: Style.font.body
      opacity: 0.6
    }
  }
}
