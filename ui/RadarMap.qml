import QtQuick
import qs.Commons
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
  property bool darkTheme: true

  // Where the map is looking.
  property real centerLatitude: 0
  property real centerLongitude: 0
  property int zoom: 7

  // The zoom the radar layers request. Radar resolution runs out before the
  // map does, so past that limit they keep asking for their deepest real tiles
  // and get scaled up over a basemap that is still sharpening.
  property int radarSourceZoom: zoom

  // function(zoom, x, y) -> string, one per layer. See RadarModel.
  property var basemapTileUrl: null
  property var radarTileUrlA: null
  property var radarTileUrlB: null

  // Which of the two radar layers holds which frame, and which is in front.
  // Bumping a layer's frame while it is behind, then swapping, is what makes
  // the loop dissolve instead of flicker.
  property int frameA: -1
  property int frameB: -1
  property bool frontIsA: true
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

  property string attribution: ""

  signal dragged(real latitude, real longitude)
  signal zoomRequested(int zoom)

  readonly property color foreground: bar ? bar.foreground : Color.foreground

  Rectangle {
    id: canvasFrame
    anchors.fill: parent
    color: root.darkTheme ? "#101014" : "#e8e8ec"
    radius: Style.cornerRadius
    clip: true

    TileLayer {
      anchors.fill: parent
      centerLatitude: root.centerLatitude
      centerLongitude: root.centerLongitude
      zoom: root.zoom
      tileUrlFor: root.basemapTileUrl
    }

    TileLayer {
      anchors.fill: parent
      centerLatitude: root.centerLatitude
      centerLongitude: root.centerLongitude
      zoom: root.zoom
      sourceZoom: root.radarSourceZoom
      tileUrlFor: root.radarTileUrlA
      revision: root.frameA + (root.colorSchemeId * 1000)
      smooth: root.smoothTiles
      opacity: root.frontIsA ? 1 : 0
      Behavior on opacity {
        NumberAnimation { duration: 380; easing.type: Easing.InOutQuad }
      }
    }

    TileLayer {
      anchors.fill: parent
      centerLatitude: root.centerLatitude
      centerLongitude: root.centerLongitude
      zoom: root.zoom
      sourceZoom: root.radarSourceZoom
      tileUrlFor: root.radarTileUrlB
      revision: root.frameB + (root.colorSchemeId * 1000)
      smooth: root.smoothTiles
      opacity: root.frontIsA ? 0 : 1
      Behavior on opacity {
        NumberAnimation { duration: 380; easing.type: Easing.InOutQuad }
      }
    }

    // ---- Alert rings and home marker ------------------------------------
    Item {
      id: homeOverlay
      anchors.fill: parent
      visible: root.hasLocation

      readonly property var home: TileMath.projectToViewport(
        root.homeLatitude, root.homeLongitude,
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
        border.color: root.darkTheme ? "#000000" : "#ffffff"
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
        var direction = wheel.angleDelta.y > 0 ? 1 : -1
        var next = Math.max(RadarModel.MIN_RADAR_ZOOM,
          Math.min(RadarModel.MAX_MAP_ZOOM, root.zoom + direction))
        if (next !== root.zoom) root.zoomRequested(next)
        wheel.accepted = true
      }
    }

    // ---- Overlays -------------------------------------------------------
    Text {
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
      anchors.centerIn: parent
      visible: root.loading
      text: "Loading radar…"
      color: root.foreground
      font.family: Style.font.family
      font.pixelSize: Style.font.body
      opacity: 0.6
    }
  }
}
