import QtQuick
import QtQuick.Effects
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "TileMath.js" as TileMath
import "RadarModel.js" as RadarModel

// The radar map.
//
// Opens centred on the location Omarchy already knows about, stacks the latest
// radar frame over a basemap, and can play the last two hours as a loop. The
// alert toggle lives down here rather than only in the settings form, so
// turning the watch on is one click from the thing you are looking at — the
// same shape as the audio panel's mute switch.
Panel {
  id: root
  moduleName: "eduardodallecort.weather-radar"
  ipcTarget: "eduardodallecort.weather-radar"
  manageIpc: false

  property var anchorItem: null
  property var hostWidget: null
  property var radar: null
  property bool openedFromHotkey: false

  // The bar tracks the widget in its slot, not this nested panel, so anything
  // the popout coordinator compares against has to be the widget.
  readonly property var barIdentity: hostWidget || root

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  readonly property bool alertsEnabled: setting("alertsEnabled", false) === true
  readonly property int alertRadiusKm: Math.max(25, Math.min(250, Number(setting("alertRadiusKm", 100)) || 100))

  // Offered in the panel as a few presets rather than a free number. The
  // radius is really a question about warning time — the service converts it
  // at an assumed 50 km/h — and storms travel anywhere from 40 to 60, so
  // treating 137 km as meaningfully different from 150 would be precision the
  // underlying model does not have. The settings form still takes any value in
  // 25 km steps, and a value set there that is not a preset is added to the
  // list rather than silently dropped.
  readonly property var radiusPresets: {
    var presets = [50, 100, 150, 200]
    if (presets.indexOf(alertRadiusKm) === -1) {
      presets.push(alertRadiusKm)
      presets.sort(function(a, b) { return a - b })
    }
    return presets.map(function(km) { return String(km) })
  }

  readonly property int alertLeadMinutes: radar ? radar.leadMinutes : Math.round(alertRadiusKm / 50 * 60)

  readonly property string alertThreshold: String(setting("alertMinIntensity", "Heavy"))
  readonly property var thresholdOptions: ["Light", "Moderate", "Heavy", "Severe"]

  // Says what the chosen band actually means in weather, rather than leaving
  // the user to guess where the line between "Moderate" and "Heavy" falls.
  function thresholdCaption(name) {
    if (name === "Light") return "anything from drizzle up"
    if (name === "Moderate") return "steady rain and worse"
    if (name === "Severe") return "only severe storms"
    return "downpours and storms"
  }

  function humanizeLead(minutes) {
    if (minutes < 60) return minutes + " min"
    var hours = Math.floor(minutes / 60)
    var rest = minutes % 60
    if (rest === 0) return hours + " h"
    return hours + " h " + rest + " min"
  }
  readonly property bool smoothTiles: setting("smoothTiles", true) === true
  readonly property bool showSnow: setting("showSnow", true) === true

  readonly property int colorSchemeId: {
    var name = String(setting("colorScheme", "TITAN"))
    for (var i = 0; i < RadarModel.COLOR_SCHEMES.length; i++) {
      if (RadarModel.COLOR_SCHEMES[i].name === name) return RadarModel.COLOR_SCHEMES[i].id
    }
    return 2
  }

  // Write one field back to this widget's inline shell.json entry, preserving
  // every other field. Same approach the first-party panels use.
  function persistSetting(key, value) {
    if (!root.bar || !root.bar.shell || typeof root.bar.shell.updateEntryInline !== "function") return
    var entry = { id: root.moduleName }
    for (var existing in settings) if (existing !== "id") entry[existing] = settings[existing]
    entry[key] = value
    root.bar.shell.updateEntryInline(root.moduleName, entry)
  }

  // ---------------------------------------------------------------------------
  // Map state
  // ---------------------------------------------------------------------------

  readonly property bool hasLocation: radar ? radar.hasLocation === true : false
  // Held rather than bound, so an absent coordinate leaves them alone instead
  // of becoming a real one. `location` is reassigned a moment before
  // `hasLocation` catches up, and a binding must yield a number — there is no
  // way to say "unchanged" — so any binding over that gap would place home at
  // 0,0, off the coast of west Africa. Updated only from values that parse.
  property real homeLatitude: 0
  property real homeLongitude: 0
  // Deliberately not gated on `hasLocation`. That flag is derived from the same
  // object and settles a moment later, so requiring it here would discard the
  // one call that carries the coordinates and leave home at 0,0 for good. The
  // parse below is the only test that matters: it accepts a usable pair and
  // ignores everything else.
  function updateHome() {
    if (!radar || !radar.location) return
    var la = parseFloat(radar.location.latitude)
    var lo = parseFloat(radar.location.longitude)
    if (!isFinite(la) || !isFinite(lo)) return

    homeLatitude = la
    homeLongitude = lo

    // Recentre here rather than from a change handler on each coordinate. Such
    // a handler fires between the two writes, on the new latitude beside the
    // old longitude — a point that never existed, which the map would centre on
    // and fetch a full round of tiles for before being corrected.
    if (!panned) recenter()
  }

  Connections {
    target: root.radar
    function onLocationChanged() { root.updateHome() }
  }

  onRadarChanged: updateHome()
  readonly property string locationName: radar ? radar.locationName : ""

  property real viewLatitude: 0
  property real viewLongitude: 0
  property int zoom: Math.max(RadarModel.MIN_RADAR_ZOOM,
    Math.min(RadarModel.MAX_MAP_ZOOM, Number(setting("defaultZoom", 7)) || 7))

  // The radar layer stops requesting new detail here and gets scaled up
  // instead, so the basemap can keep sharpening past the data's limit.
  readonly property int radarSourceZoom: Math.min(zoom, RadarModel.MAX_RADAR_ZOOM)
  readonly property bool radarUpscaled: zoom > RadarModel.MAX_RADAR_ZOOM

  function recenter() {
    // Nothing to centre on before a location exists; recentring on the
    // placeholder would move the view to 0,0 rather than leave it alone.
    if (!hasLocation) return
    viewLatitude = homeLatitude
    viewLongitude = homeLongitude
  }

  onHasLocationChanged: {
    // updateHome recentres itself when it lands a usable pair, and when it
    // does not the coordinates are unusable anyway — so there is nothing to
    // add here.
    updateHome()
  }
  property bool panned: false

  // ---------------------------------------------------------------------------
  // Location editing
  // ---------------------------------------------------------------------------
  //
  // Deliberately the same picker as the stock weather widget: same geocoding
  // endpoint, same suggestion rows, same omarchy-weather-location call. There
  // is one location on this machine, and it is the weather widget's file. A
  // second picker that wrote somewhere else would be two answers to the same
  // question; this one writes to the same place, so changing the city here
  // moves the stock weather widget too, and vice versa — both watch the file.

  property bool editingLocation: false
  property bool savingLocation: false
  property var locationSuggestions: []
  property int suggestionIndex: 0
  property string geocodePendingQuery: ""
  property string geocodeActiveQuery: ""

  function startEditingLocation() {
    if (editingLocation) return
    editingLocation = true
    locationSuggestions = []
    suggestionIndex = 0
    locationField.text = root.locationName
    Qt.callLater(function() { locationField.forceActiveFocus() })
  }

  function cancelEditingLocation() {
    editingLocation = false
    savingLocation = false
    locationSuggestions = []
    suggestionIndex = 0
    geocodePendingQuery = ""
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }

  function commitLocation() {
    var choice = RadarModel.locationCommit(locationField.text, locationSuggestions, suggestionIndex)
    if (!choice.name) {
      clearLocation()
      return
    }
    savingLocation = true
    persistLocation(choice.name, choice.latitude, choice.longitude)
  }

  function pickSuggestion(suggestion) {
    if (!suggestion) return
    savingLocation = true
    persistLocation(suggestion.name, suggestion.latitude, suggestion.longitude)
  }

  function clearLocation() {
    savingLocation = true
    persistLocation("", null, null)
  }

  // What the last save asked for, so a save that changes nothing can be told
  // apart from one that does.
  property real pendingLatitude: NaN
  property real pendingLongitude: NaN

  function persistLocation(name, latitude, longitude) {
    pendingLatitude = parseFloat(latitude)
    pendingLongitude = parseFloat(longitude)

    if (name && latitude !== null && longitude !== null)
      locationSaveProc.command = ["omarchy-weather-location", "--set", name, latitude + "," + longitude]
    else if (name)
      locationSaveProc.command = ["omarchy-weather-location", "--set", name]
    else
      locationSaveProc.command = ["omarchy-weather-location", "--clear"]
    locationSaveProc.running = true
  }

  // Debounced so typing a city name is one request per pause, not one per
  // keystroke. Only one curl is in flight at a time; a query that moved on
  // while a fetch was running is issued as soon as that one returns.
  function requestGeocode() {
    var query = locationField.text.trim()
    if (query.length < 2) {
      locationSuggestions = []
      return
    }
    geocodePendingQuery = query
    if (!geocodeProc.running) startGeocode()
  }

  function startGeocode() {
    geocodeActiveQuery = geocodePendingQuery
    geocodeProc.command = ["curl", "-fsS", "--max-time", "5", RadarModel.geocodingUrl(geocodeActiveQuery, 5)]
    geocodeProc.running = true
  }

  Timer {
    id: geocodeDebounce
    interval: 220
    onTriggered: root.requestGeocode()
  }

  Process {
    id: geocodeProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        root.locationSuggestions = root.editingLocation ? RadarModel.parseGeocodingResults(text) : []
        root.suggestionIndex = 0
        if (root.geocodePendingQuery !== root.geocodeActiveQuery) Qt.callLater(root.startGeocode)
      }
    }
  }

  Process {
    id: locationSaveProc
    onExited: function(exitCode) {
      root.savingLocation = false
      if (exitCode !== 0) return

      // Clear `panned` before anything can deliver a location, so the order of
      // what follows cannot decide whether the map recentres.
      root.panned = false

      // Recentre now only when what was saved is what home already holds —
      // re-choosing the stored city, where identical coordinates mean no
      // property changes and so nothing else would fire. Doing it
      // unconditionally would snap the map to the previous city first on a
      // move, and onto the city just removed on a clear.
      if (isFinite(root.pendingLatitude)
          && root.pendingLatitude === root.homeLatitude
          && root.pendingLongitude === root.homeLongitude) root.recenter()

      // Then ask the service to re-read rather than waiting for its file watch.
      // The first location ever written lands in a directory that did not exist
      // when that watch was set up, so nothing would announce it. A different
      // city arrives asynchronously and recentres again.
      if (root.radar && root.radar.reloadLocation) root.radar.reloadLocation()

      root.cancelEditingLocation()
    }
  }

  // ---------------------------------------------------------------------------
  // Frames
  // ---------------------------------------------------------------------------

  readonly property var frames: radar ? radar.frames : []
  property int frameIndex: 0
  property bool playing: false

  readonly property var currentFrame: {
    if (!frames || frames.length === 0) return null
    var index = Math.max(0, Math.min(frames.length - 1, frameIndex))
    return frames[index]
  }

  readonly property string frameLabel: currentFrame ? RadarModel.formatFrameTime(currentFrame.time) : "--:--"
  readonly property bool isLatestFrame: frames.length > 0 && frameIndex >= frames.length - 1

  // A new manifest arrives every ten minutes. Someone parked on the newest
  // frame wants to stay on the newest frame; someone scrubbing through history
  // wants to stay where they put the cursor.
  onFramesChanged: {
    if (frames.length === 0) return
    if (frameIndex >= frames.length - 1 || frameIndex === 0) frameIndex = frames.length - 1
    if (frameA < 0) { frameA = frameIndex; frontIsA = true }
  }

  // Crossfade state. Two radar layers alternate: the incoming frame is loaded
  // into whichever is currently behind, then the two swap opacity. Hard-cutting
  // between frames reads as a flicker, because consecutive radar frames differ
  // enough that the eye registers the swap rather than the motion.
  property int frameA: -1
  property int frameB: -1
  property bool frontIsA: true

  onFrameIndexChanged: showFrame(frameIndex)

  function showFrame(index) {
    if (index < 0 || frames.length === 0) return
    if (frontIsA) frameB = index
    else frameA = index
    frontIsA = !frontIsA
  }

  function radarTileUrlForFrame(index, z, x, y) {
    if (!root.radar || !root.radar.tileHost) return ""
    if (index < 0 || index >= root.frames.length) return ""
    return RadarModel.tileUrl(root.radar.tileHost, root.frames[index].path, 256,
      z, x, y, root.colorSchemeId, root.smoothTiles, root.showSnow)
  }

  Timer {
    id: playbackTimer
    // Slow enough to read the motion rather than watch a strobe, with a longer
    // hold on the newest frame so the loop ends on the picture that matters
    // and the restart is legible as a restart.
    interval: root.isLatestFrame ? 1500 : 550
    repeat: true
    running: root.playing && root.opened && root.frames.length > 1
    onTriggered: {
      if (root.frameIndex >= root.frames.length - 1) root.frameIndex = 0
      else root.frameIndex++
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  function open() {
    openedFromHotkey = false
    setCenterHoverRevealSuppressed(false)
    root.controller.show()
    root.onOpened()
  }

  function openFromHotkey() {
    openedFromHotkey = true
    root.controller.show()
    root.onOpened()
    Qt.callLater(function() {
      if (root.opened) setCenterHoverRevealSuppressed(true)
    })
  }

  function close() {
    setCenterHoverRevealSuppressed(false)
    root.playing = false
    if (root.editingLocation) root.cancelEditingLocation()
    if (root.radar && root.manifestHeld) {
      root.radar.releaseManifest()
      root.manifestHeld = false
    }
    root.controller.hide()
  }

  function toggle() {
    if (root.opened) root.close()
    else root.openFromHotkey()
  }

  property bool manifestHeld: false

  // A bar surface is rebuilt per monitor, so a panel can be destroyed while it
  // still holds the manifest — unplugging a screen with the map open. Without
  // this the refcount never comes back down and the service keeps fetching
  // frames for a panel nobody has.
  Component.onDestruction: {
    if (manifestHeld && root.radar && root.radar.releaseManifest) root.radar.releaseManifest()
  }

  function onOpened() {
    if (!panned && hasLocation) recenter()
    if (root.radar && !manifestHeld) {
      root.radar.acquireManifest()
      manifestHeld = true
    }
    // The canvas can only read pixels while it is on screen, so opening is
    // the moment to ask.
    Qt.callLater(function() { coverageProbe.probe() })
  }

  function switchPanel(direction) {
    if (root.bar && typeof root.bar.switchPanelFrom === "function")
      return root.bar.switchPanelFrom(root.barIdentity, direction)
    return false
  }

  function setCenterHoverRevealSuppressed(value) {
    if (root.bar && "centerHoverRevealSuppressed" in root.bar)
      root.bar.centerHoverRevealSuppressed = value
  }

  IpcHandler {
    target: root.ipcTarget

    function open(): void { root.openFromHotkey() }
    function close(): void { root.close() }
    function show(): void { root.openFromHotkey() }
    function hide(): void { root.close() }
    function toggle(): void { root.toggle() }
  }

  // ---------------------------------------------------------------------------
  // Basemap
  // ---------------------------------------------------------------------------

  // OpenStreetMap's standard raster tiles need no account or API key. A local
  // helper gives requests the provider-required identity and disk cache; it
  // exposes only an ephemeral loopback port. A lightweight effect darkens the
  // same tiles for dark themes so radar remains readable.
  readonly property bool darkTheme: {
    var background = Color.background
    return (0.2126 * background.r + 0.7152 * background.g + 0.0722 * background.b) < 0.5
  }
  function basemapTileUrl(z, x, y) {
    var port = radar ? Number(radar.basemapProxyPort || 0) : 0
    if (port <= 0) return ""
    return "http://127.0.0.1:" + port + "/" + z + "/" + x + "/" + y + ".png"
  }

  function radarTileUrlA(z, x, y) { return root.radarTileUrlForFrame(root.frameA, z, x, y) }
  function radarTileUrlB(z, x, y) { return root.radarTileUrlForFrame(root.frameB, z, x, y) }

  // ---------------------------------------------------------------------------
  // Radar coverage
  // ---------------------------------------------------------------------------
  //
  // Large parts of the world have no ground radar at all, and there the map is
  // simply empty — which is indistinguishable from "no rain today" and reads as
  // a broken plugin. RainViewer publishes a coverage mask that is transparent
  // where a radar reaches and opaque black where none does, so the question is
  // answerable: fetch the mask centred on the user and read the middle pixel,
  // which is their location by construction.
  //
  // The probe lives here rather than in the service because reading pixels
  // needs a scene to render into, and a headless singleton has none.

  readonly property string coverageProbeUrl: {
    if (!radar || !radar.tileHost || !hasLocation) return ""
    if (radar.coverageChecked) return ""
    return RadarModel.coverageTileUrl(radar.tileHost, 256, RadarModel.MAX_RADAR_ZOOM,
      homeLatitude, homeLongitude)
  }

  readonly property bool coverageMissing: radar ? (radar.coverageChecked && !radar.hasCoverage) : false

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    centerOnBar: true
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(560))
    contentHeight: panel.fittedContentHeight(content.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      // While the search field has focus its keystrokes are text, not
      // shortcuts: without this, typing a city name would scrub the timeline
      // and zoom the map.
      blocked: root.editingLocation
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onReturnRequested: root.playing = !root.playing

      Keys.onPressed: function(event) {
        if (event.key === Qt.Key_Left) {
          root.playing = false
          root.frameIndex = Math.max(0, root.frameIndex - 1)
          event.accepted = true
        } else if (event.key === Qt.Key_Right) {
          root.playing = false
          root.frameIndex = Math.min(root.frames.length - 1, root.frameIndex + 1)
          event.accepted = true
        } else if (event.key === Qt.Key_Plus || event.key === Qt.Key_Equal) {
          root.zoom = Math.min(RadarModel.MAX_MAP_ZOOM, root.zoom + 1)
          event.accepted = true
        } else if (event.key === Qt.Key_Minus) {
          root.zoom = Math.max(RadarModel.MIN_RADAR_ZOOM, root.zoom - 1)
          event.accepted = true
        } else if (event.key === Qt.Key_Home) {
          root.panned = false
          root.recenter()
          event.accepted = true
        }
      }

      Column {
        id: content
        width: parent.width
        spacing: Style.space(10)

        // ---- Map ------------------------------------------------------------
        Item {
          id: mapArea
          width: parent.width
          height: Style.space(320)

          Rectangle {
            anchors.fill: parent
            color: root.darkTheme ? "#101014" : "#e8e8ec"
            radius: Style.cornerRadius
            clip: true

            TileLayer {
              id: basemapLayer
              anchors.fill: parent
              centerLatitude: root.viewLatitude
              centerLongitude: root.viewLongitude
              zoom: root.zoom
              tileUrlFor: root.basemapTileUrl
              revision: root.radar ? root.radar.basemapProxyPort : 0
              layer.enabled: root.darkTheme
              layer.smooth: true
              layer.effect: MultiEffect {
                brightness: -0.48
                contrast: 0.12
                saturation: -0.35
              }
            }

            // Two radar layers that trade places. See showFrame(): the next
            // frame is loaded into whichever layer is behind, then the pair
            // swaps opacity, so the loop dissolves instead of flickering.
            TileLayer {
              id: radarA
              anchors.fill: parent
              centerLatitude: root.viewLatitude
              centerLongitude: root.viewLongitude
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
              id: radarB
              anchors.fill: parent
              centerLatitude: root.viewLatitude
              centerLongitude: root.viewLongitude
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

            // ---- Alert rings and home marker --------------------------------
            Item {
              anchors.fill: parent
              visible: root.hasLocation

              readonly property var home: TileMath.projectToViewport(
                root.homeLatitude, root.homeLongitude,
                root.viewLatitude, root.viewLongitude,
                root.zoom, parent.width, parent.height)

              readonly property real ringRadius: TileMath.kmToPixels(
                root.alertRadiusKm, root.homeLatitude, root.zoom)

              // Outer ring is the configured alert radius; the inner half-ring
              // gives a sense of scale without needing a legend.
              Repeater {
                model: [0.5, 1.0]

                Rectangle {
                  required property real modelData
                  readonly property real r: parent.ringRadius * modelData
                  x: parent.home.x - r
                  y: parent.home.y - r
                  width: r * 2
                  height: r * 2
                  radius: r
                  color: "transparent"
                  border.color: Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b,
                    modelData === 1.0 ? 0.55 : 0.3)
                  border.width: 1
                  visible: root.alertsEnabled && r > 6 && r < parent.width * 2
                }
              }

              Rectangle {
                readonly property real dot: Style.space(7)
                x: parent.home.x - dot / 2
                y: parent.home.y - dot / 2
                width: dot
                height: dot
                radius: dot / 2
                color: Color.accent
                border.color: root.darkTheme ? "#000000" : "#ffffff"
                border.width: 1
              }
            }

            // ---- Pan and zoom -----------------------------------------------
            MouseArea {
              id: mapMouse
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

                // Convert the drag into a new centre by asking which
                // coordinate now sits under the middle of the viewport.
                var moved = TileMath.unprojectFromViewport(
                  width / 2 - dx, height / 2 - dy,
                  root.viewLatitude, root.viewLongitude,
                  root.zoom, width, height)
                root.viewLatitude = moved.latitude
                root.viewLongitude = moved.longitude
                root.panned = true
              }

              onWheel: function(wheel) {
                var direction = wheel.angleDelta.y > 0 ? 1 : -1
                var next = Math.max(RadarModel.MIN_RADAR_ZOOM,
                  Math.min(RadarModel.MAX_MAP_ZOOM, root.zoom + direction))
                if (next !== root.zoom) root.zoom = next
                wheel.accepted = true
              }
            }

            // ---- Overlays ---------------------------------------------------
            Text {
              anchors.right: parent.right
              anchors.bottom: parent.bottom
              anchors.margins: Style.space(6)
              text: "RainViewer · © OpenStreetMap contributors"
              color: root.bar ? root.bar.foreground : Color.foreground
              font.family: Style.font.family
              font.pixelSize: Style.font.caption * 0.8
              opacity: 0.4
            }

            // Off-screen probe for the coverage mask. Kept at zero opacity
            // rather than hidden: an invisible item is never rendered, and a
            // Canvas that is never rendered never paints, so it would have
            // nothing to read.
            Canvas {
              id: coverageProbe
              width: 256
              height: 256
              opacity: 0
              z: -1

              property string probeUrl: root.coverageProbeUrl

              // Driven explicitly rather than by the load signal alone. A
              // canvas only paints while it is rendered, so a probe begun
              // against a closed panel queues a repaint that never arrives,
              // and an image already in Qt's cache does not re-emit
              // imageLoaded to restart one.
              function probe() {
                if (probeUrl === "") return
                if (isImageLoaded(probeUrl)) requestPaint()
                else loadImage(probeUrl)
              }

              onProbeUrlChanged: probe()
              onImageLoaded: requestPaint()

              onPaint: {
                if (probeUrl === "" || !isImageLoaded(probeUrl)) return
                var ctx = getContext("2d")
                ctx.clearRect(0, 0, width, height)
                ctx.drawImage(probeUrl, 0, 0, width, height)
                var pixels = ctx.getImageData(0, 0, width, height).data
                var covered = RadarModel.hasCoverageAtCenter(pixels, width)
                if (root.radar && root.radar.reportCoverage) root.radar.reportCoverage(covered)
                if (!covered) console.log("weather-radar: no ground radar reaches the configured location")
              }
            }

            // Shown while the manifest has not arrived yet, so an empty map
            // during the first second does not read as "no rain".
            Text {
              anchors.centerIn: parent
              visible: root.frames.length === 0
              text: "Loading radar…"
              color: root.bar ? root.bar.foreground : Color.foreground
              font.family: Style.font.family
              font.pixelSize: Style.font.body
              opacity: 0.6
            }
          }
        }

        // ---- Timeline ---------------------------------------------------------
        Item {
          width: parent.width
          height: Style.spacing.controlHeight
          visible: root.frames.length > 1

          Button {
            id: playButton
            anchors.left: parent.left
            anchors.leftMargin: Style.space(8)
            anchors.verticalCenter: parent.verticalCenter
            // Material Design play / pause, both present in every Nerd Font
            // Omarchy ships.
            text: root.playing ? "󰏤" : "󰐊"
            fontFamily: Style.font.family
            foreground: root.bar ? root.bar.foreground : Color.foreground
            tooltipText: root.playing ? "Pause (Enter)" : "Play the last two hours (Enter)"
            onClicked: root.playing = !root.playing
          }

          PanelSlider {
            id: timeline
            anchors.left: playButton.right
            anchors.right: frameTime.left
            anchors.leftMargin: Style.space(8)
            anchors.rightMargin: Style.space(10)
            anchors.verticalCenter: parent.verticalCenter
            bar: root.bar
            minimum: 0
            maximum: Math.max(1, root.frames.length - 1)
            integer: true
            step: 1
            tickCount: root.frames.length
            value: root.frameIndex
            onMoved: function(value) {
              root.playing = false
              root.frameIndex = Math.round(value)
            }
          }

          // Fixed width, and no suffix that appears and disappears. The label
          // sits at the end of the slider's anchor chain, so any change to its
          // width resizes the track — which, mid-drag, slides the knob out
          // from under the pointer. A clock that only ever renders five
          // characters cannot do that, and the timestamp already says whether
          // you are looking at the past.
          Text {
            id: frameTime
            anchors.right: parent.right
            anchors.rightMargin: Style.space(10)
            anchors.verticalCenter: parent.verticalCenter
            width: Style.space(44)
            horizontalAlignment: Text.AlignRight
            text: root.frameLabel
            color: root.bar ? root.bar.foreground : Color.foreground
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
            opacity: root.isLatestFrame ? 0.9 : 0.6
          }
        }

        PanelSeparator { width: parent.width }

        // ---- Location ----------------------------------------------------------
        Item {
          width: parent.width
          height: Style.spacing.controlHeight

          // Resting state: the city name, click to change it.
          Row {
            visible: !root.editingLocation
            anchors.left: parent.left
            anchors.leftMargin: Style.space(12)
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(8)

            Text {
              anchors.verticalCenter: parent.verticalCenter
              text: root.locationName !== "" ? root.locationName : "Set a location"
              color: root.bar ? root.bar.foreground : Color.foreground
              font.family: Style.font.family
              font.pixelSize: Style.font.body
              opacity: root.locationName !== "" ? 1 : 0.6
            }

            Text {
              anchors.verticalCenter: parent.verticalCenter
              text: "󰏫"
              color: root.bar ? root.bar.foreground : Color.foreground
              font.family: Style.font.family
              font.pixelSize: Style.font.bodySmall
              opacity: 0.45
            }

            // Sits beside the city rather than over the map: this is a fact
            // about the configured location, not about whatever the view
            // happens to be showing, and a message centred on a map that can
            // be panned anywhere would claim the latter.
            Text {
              anchors.verticalCenter: parent.verticalCenter
              visible: root.coverageMissing
              text: "· no radar coverage"
              color: Color.urgent
              font.family: Style.font.family
              font.pixelSize: Style.font.caption
              opacity: 0.9
            }
          }

          MouseArea {
            anchors.fill: parent
            visible: !root.editingLocation
            hoverEnabled: true
            cursorShape: Qt.PointingHandCursor
            onClicked: root.startEditingLocation()
          }

          // Editing state, mirroring the stock weather widget's picker.
          Row {
            visible: root.editingLocation
            anchors.left: parent.left
            anchors.leftMargin: Style.space(12)
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(6)

            TextField {
              id: locationField
              width: Style.space(220)
              enabled: !root.savingLocation
              placeholderText: "Search city"
              foreground: root.bar ? root.bar.foreground : Color.foreground
              font.family: Style.font.family

              onTextChanged: if (root.editingLocation && !root.savingLocation) geocodeDebounce.restart()

              Keys.onPressed: function(event) {
                if (event.key === Qt.Key_Escape) {
                  root.cancelEditingLocation()
                  event.accepted = true
                } else if (event.key === Qt.Key_Down) {
                  if (root.suggestionIndex < root.locationSuggestions.length - 1) root.suggestionIndex++
                  event.accepted = true
                } else if (event.key === Qt.Key_Up) {
                  if (root.suggestionIndex > 0) root.suggestionIndex--
                  event.accepted = true
                } else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
                  root.commitLocation()
                  event.accepted = true
                }
              }
            }

            // Clear back to IP auto-detect; becomes a spinner while saving.
            Rectangle {
              width: Style.space(18)
              height: Style.space(18)
              anchors.verticalCenter: parent.verticalCenter
              radius: Math.min(4, Style.cornerRadius)
              color: !root.savingLocation && clearLocationArea.containsMouse
                ? Style.hoverFillFor(root.bar ? root.bar.foreground : Color.foreground, Color.accent)
                : "transparent"

              Text {
                anchors.centerIn: parent
                text: root.savingLocation ? "󰦖" : "✕"
                font.family: Style.font.family
                color: Qt.darker(root.bar ? root.bar.foreground : Color.foreground, 1.4)
                font.pixelSize: Style.font.bodySmall

                RotationAnimator on rotation {
                  running: root.savingLocation
                  from: 0
                  to: 360
                  duration: 800
                  loops: Animation.Infinite
                }
              }

              MouseArea {
                id: clearLocationArea
                anchors.fill: parent
                hoverEnabled: true
                enabled: !root.savingLocation
                cursorShape: Qt.PointingHandCursor
                onClicked: root.clearLocation()
              }
            }
          }
        }

        // ---- Geocoding suggestions ---------------------------------------------
        Column {
          width: parent.width
          spacing: 0
          visible: root.editingLocation && !root.savingLocation && root.locationSuggestions.length > 0

          Repeater {
            model: root.locationSuggestions

            Rectangle {
              required property var modelData
              required property int index

              width: parent.width
              height: suggestionRow.implicitHeight + Style.space(12)
              radius: Style.cornerRadius
              color: index === root.suggestionIndex
                ? Style.hoverFillFor(root.bar ? root.bar.foreground : Color.foreground, Color.accent)
                : "transparent"

              Row {
                id: suggestionRow
                anchors.left: parent.left
                anchors.leftMargin: Style.space(16)
                anchors.verticalCenter: parent.verticalCenter
                spacing: Style.space(8)

                Text {
                  text: modelData.name
                  color: index === root.suggestionIndex
                    ? Style.hoverStateColor(root.bar ? root.bar.foreground : Color.foreground, Color.accent)
                    : (root.bar ? root.bar.foreground : Color.foreground)
                  font.family: Style.font.family
                  font.pixelSize: Style.font.body
                }

                Text {
                  visible: text !== ""
                  text: modelData.description
                  color: Qt.darker(root.bar ? root.bar.foreground : Color.foreground, 1.5)
                  font.family: Style.font.family
                  font.pixelSize: Style.font.bodySmall
                  anchors.verticalCenter: parent.verticalCenter
                }
              }

              MouseArea {
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onPositionChanged: root.suggestionIndex = index
                onClicked: root.pickSuggestion(modelData)
              }
            }
          }
        }

        PanelSeparator { width: parent.width }

        // ---- Alerts ------------------------------------------------------------
        Item {
          width: parent.width
          height: Style.spacing.controlHeight

          Column {
            anchors.left: parent.left
            anchors.leftMargin: Style.space(12)
            anchors.verticalCenter: parent.verticalCenter
            spacing: 1

            Text {
              text: "Storm alerts"
              color: root.bar ? root.bar.foreground : Color.foreground
              font.family: Style.font.family
              font.pixelSize: Style.font.body
            }

            Text {
              // Proof the switch is doing something, rather than a silent
              // toggle the user has to take on faith.
              text: {
                if (!root.alertsEnabled) return "off"
                if (!root.hasLocation) return "no location set"
                if (root.radar && root.radar.checking) return "checking…"
                if (root.radar && root.radar.lastCheckTime > 0) {
                  if (root.radar.outlookLevel === 0) return "nothing expected"
                  var outlook = root.radar.outlookLabel.toLowerCase() + " expected"
                  return root.radar.outlookAtClock !== ""
                    ? outlook + " around " + root.radar.outlookAtClock
                    : outlook
                }
                return "starting…"
              }
              color: root.bar ? root.bar.foreground : Color.foreground
              font.family: Style.font.family
              font.pixelSize: Style.font.caption
              opacity: 0.55
            }
          }

          ToggleSwitch {
            anchors.right: parent.right
            anchors.rightMargin: Style.space(12)
            anchors.verticalCenter: parent.verticalCenter
            checked: root.alertsEnabled
            busy: root.alertsEnabled && root.radar ? root.radar.checking : false
            foreground: root.bar ? root.bar.foreground : Color.foreground
            onToggled: {
              var next = !root.alertsEnabled
              root.persistSetting("alertsEnabled", next)
              // Fire the first check immediately so enabling produces a
              // visible result instead of up to ten minutes of silence.
              if (next && root.radar && root.radar.checkNow) Qt.callLater(root.radar.checkNow)
            }
          }
        }

        // ---- Alert radius ------------------------------------------------------
        // Only while alerts are on: with them off there is nothing to tune, and
        // the rings it controls are not drawn either.
        Item {
          width: parent.width
          height: Style.spacing.controlHeight
          visible: root.alertsEnabled

          Column {
            anchors.left: parent.left
            anchors.leftMargin: Style.space(12)
            anchors.verticalCenter: parent.verticalCenter
            spacing: 1

            Text {
              text: "Alert radius (km)"
              color: root.bar ? root.bar.foreground : Color.foreground
              font.family: Style.font.family
              font.pixelSize: Style.font.body
            }

            // The kilometres are what the rings show; the hours are what the
            // number actually means. Saying both keeps the control honest
            // about being an approximation.
            Text {
              text: "about " + root.humanizeLead(root.alertLeadMinutes) + " of warning"
              color: root.bar ? root.bar.foreground : Color.foreground
              font.family: Style.font.family
              font.pixelSize: Style.font.caption
              opacity: 0.55
            }
          }

          ButtonGroup {
            anchors.right: parent.right
            anchors.rightMargin: Style.space(12)
            anchors.verticalCenter: parent.verticalCenter
            options: root.radiusPresets
            value: String(root.alertRadiusKm)
            foreground: root.bar ? root.bar.foreground : Color.foreground
            background: root.bar ? root.bar.background : Color.background
            onChanged: function(value) {
              var km = parseInt(value, 10)
              if (!isFinite(km) || km === root.alertRadiusKm) return
              // The service watches for this and re-checks on its own, so that
              // changing the radius from the settings form behaves the same as
              // changing it here.
              root.persistSetting("alertRadiusKm", km)
            }
          }
        }

        // ---- Alert threshold ---------------------------------------------------
        // The radius decides how far ahead to look; this decides how bad it has
        // to be to be worth interrupting for. Without it, a two-hour window in
        // a wet season would fire on every passing shower, and the plugin would
        // be switched off — taking the alert that mattered with it.
        Item {
          width: parent.width
          height: Style.spacing.controlHeight
          visible: root.alertsEnabled

          Column {
            anchors.left: parent.left
            anchors.leftMargin: Style.space(12)
            anchors.verticalCenter: parent.verticalCenter
            spacing: 1

            Text {
              text: "Notify me about"
              color: root.bar ? root.bar.foreground : Color.foreground
              font.family: Style.font.family
              font.pixelSize: Style.font.body
            }

            Text {
              text: root.thresholdCaption(root.alertThreshold)
              color: root.bar ? root.bar.foreground : Color.foreground
              font.family: Style.font.family
              font.pixelSize: Style.font.caption
              opacity: 0.55
            }
          }

          ButtonGroup {
            anchors.right: parent.right
            anchors.rightMargin: Style.space(12)
            anchors.verticalCenter: parent.verticalCenter
            options: root.thresholdOptions
            value: root.alertThreshold
            foreground: root.bar ? root.bar.foreground : Color.foreground
            background: root.bar ? root.bar.background : Color.background
            onChanged: function(value) {
              if (value === root.alertThreshold) return
              root.persistSetting("alertMinIntensity", value)
            }
          }
        }
      }
    }
  }
}
