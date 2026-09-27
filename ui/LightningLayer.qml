import QtQuick
import "../lib/TileMath.js" as TileMath

// Lightning over the map: a plus per strike, white and full size when new,
// cooling through yellow and orange to a faint red over the twenty minutes a
// strike is kept. Strikes are {latitude, longitude, time}, oldest first, so
// the newest are drawn on top.
Canvas {
  id: root

  property var strikes: []
  property int strikeRevision: 0
  property real centerLatitude: 0
  property real centerLongitude: 0
  property int zoom: 7


  renderStrategy: Canvas.Cooperative

  readonly property string view: [root.centerLatitude, root.centerLongitude,
    root.zoom, width, height, root.strikeRevision].join(":")
  onViewChanged: requestPaint()
  onVisibleChanged: if (visible) requestPaint()

  // Strikes cool with age even when none arrive or expire.
  Timer {
    interval: 30000
    repeat: true
    running: root.visible && root.strikes && root.strikes.length > 0
    onTriggered: root.requestPaint()
  }

  function strikeStyle(ageMs) {
    var m = ageMs / 60000
    if (m < 1) return { color: "#ffffff", alpha: 1.0, size: 6 }
    if (m < 5) return { color: "#ffe14d", alpha: 0.95, size: 5 }
    if (m < 10) return { color: "#ff9a1f", alpha: 0.85, size: 4 }
    if (m < 15) return { color: "#ff4a1f", alpha: 0.7, size: 4 }
    return { color: "#c01818", alpha: 0.5, size: 3 }
  }

  onPaint: {
    var ctx = getContext("2d")
    ctx.reset()
    if (!visible || !root.strikes || root.strikes.length === 0) return
    var now = Date.now()
    ctx.lineCap = "round"
    for (var i = 0; i < root.strikes.length; i++) {
      var s = root.strikes[i]
      var p = TileMath.projectToViewport(s.latitude,
        TileMath.nearestLongitude(s.longitude, root.centerLongitude),
        root.centerLatitude, root.centerLongitude, root.zoom, width, height)
      if (p.x < -8 || p.y < -8 || p.x > width + 8 || p.y > height + 8) continue
      var st = strikeStyle(now - s.time)
      var r = st.size
      // A dark halo keeps light strikes legible over pale radar echoes.
      ctx.globalAlpha = st.alpha * 0.6
      ctx.strokeStyle = "#000000"
      ctx.lineWidth = 3.5
      ctx.beginPath()
      ctx.moveTo(p.x - r, p.y); ctx.lineTo(p.x + r, p.y)
      ctx.moveTo(p.x, p.y - r); ctx.lineTo(p.x, p.y + r)
      ctx.stroke()
      ctx.globalAlpha = st.alpha
      ctx.strokeStyle = st.color
      ctx.lineWidth = 1.6
      ctx.stroke()
    }
  }
}
