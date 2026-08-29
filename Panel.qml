import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "ui"
import "lib/Alerts.js" as Alerts
import "lib/Glyphs.js" as Glyphs
import "lib/Settings.js" as Settings
import "lib/TileMath.js" as TileMath
import "lib/RadarModel.js" as RadarModel

// The radar panel.
//
// Opens centred on the location Omarchy already knows about, stacks the latest
// radar frame over a basemap, and can play the last two hours as a loop. The
// alert toggle lives down here rather than only in the settings form, so
// turning the watch on is one click from the thing you are looking at — the
// same shape as the audio panel's mute switch.
//
// This file owns the state the pieces in ui/ share — where the map is looking,
// which frame is on screen, what is being edited — plus the lifecycle, the
// keyboard map and the IPC surface. Everything drawn is a component in ui/;
// everything computed is a function in lib/.
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

  // Every reading goes through Settings.js, which the service reads through as
  // well, so the panel and the alert that fires from it cannot disagree about
  // what the user configured.
  readonly property bool alertsEnabled: Settings.alertsEnabled(settings)
  readonly property int alertRadiusKm: Settings.alertRadiusKm(settings)
  readonly property var radiusPresets: Settings.radiusPresets(alertRadiusKm)
  readonly property string alertThreshold: Settings.alertThreshold(settings)
  readonly property var thresholdOptions: Alerts.THRESHOLD_OPTIONS
  readonly property bool smoothTiles: Settings.smoothTiles(settings)
  readonly property bool showSnow: Settings.showSnow(settings)
  readonly property int colorSchemeId: Settings.colorSchemeId(settings)

  // The service is the authority on lead time whenever it is mounted; the
  // fallback covers the moment before it is.
  readonly property int alertLeadMinutes: radar ? radar.leadMinutes : Alerts.leadMinutesFor(alertRadiusKm)

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
  property int zoom: Settings.defaultZoom(settings)

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
    locationPicker.query = root.locationName
    Qt.callLater(function() { locationPicker.focusQuery() })
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
    var choice = RadarModel.locationCommit(locationPicker.query, locationSuggestions, suggestionIndex)
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
    var query = locationPicker.query.trim()
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

  // CARTO's label-light basemaps, picked to match the theme rather than a
  // fixed palette: radar over a bright map in a dark theme is unreadable.
  readonly property bool darkTheme: {
    var background = Color.background
    return (0.2126 * background.r + 0.7152 * background.g + 0.0722 * background.b) < 0.5
  }
  readonly property string basemapStyle: darkTheme ? "dark_all" : "light_all"

  function basemapTileUrl(z, x, y) {
    return "https://basemaps.cartocdn.com/" + basemapStyle + "/" + z + "/" + x + "/" + y + ".png"
  }

  // Credit for everything drawn on the map, in one place so it cannot fall out
  // of step with where the tiles actually come from.
  readonly property string attribution: "RainViewer · CARTO · OpenStreetMap"

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
  // The probe is mounted in the panel's tree rather than in the service
  // because reading pixels needs a scene to render into, and a headless
  // singleton has none. See ui/CoverageProbe.qml.

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

        RadarMap {
          width: parent.width
          height: Style.space(320)
          bar: root.bar
          darkTheme: root.darkTheme

          centerLatitude: root.viewLatitude
          centerLongitude: root.viewLongitude
          zoom: root.zoom
          radarSourceZoom: root.radarSourceZoom

          basemapTileUrl: root.basemapTileUrl
          radarTileUrlA: root.radarTileUrlA
          radarTileUrlB: root.radarTileUrlB

          frameA: root.frameA
          frameB: root.frameB
          frontIsA: root.frontIsA
          colorSchemeId: root.colorSchemeId
          smoothTiles: root.smoothTiles

          hasLocation: root.hasLocation
          homeLatitude: root.homeLatitude
          homeLongitude: root.homeLongitude
          alertsEnabled: root.alertsEnabled
          alertRadiusKm: root.alertRadiusKm

          loading: root.frames.length === 0
          attribution: root.attribution

          onDragged: function(latitude, longitude) {
            root.viewLatitude = latitude
            root.viewLongitude = longitude
            root.panned = true
          }
          onZoomRequested: function(zoom) { root.zoom = zoom }

          CoverageProbe {
            id: coverageProbe
            source: root.coverageProbeUrl
            onResolved: function(covered) {
              if (root.radar && root.radar.reportCoverage) root.radar.reportCoverage(covered)
              if (!covered) console.log("weather-radar: no ground radar reaches the configured location")
            }
          }
        }

        Timeline {
          width: parent.width
          bar: root.bar
          frames: root.frames
          frameIndex: root.frameIndex
          playing: root.playing
          frameLabel: root.frameLabel
          isLatestFrame: root.isLatestFrame
          onPlayToggled: root.playing = !root.playing
          onFrameRequested: function(index) {
            root.playing = false
            root.frameIndex = index
          }
        }

        PanelSeparator { width: parent.width }

        LocationPicker {
          id: locationPicker
          width: parent.width
          spacing: parent.spacing
          bar: root.bar
          locationName: root.locationName
          coverageMissing: root.coverageMissing
          editing: root.editingLocation
          saving: root.savingLocation
          suggestions: root.locationSuggestions
          suggestionIndex: root.suggestionIndex

          onEditRequested: root.startEditingLocation()
          onCancelRequested: root.cancelEditingLocation()
          onCommitRequested: root.commitLocation()
          onClearRequested: root.clearLocation()
          onQueryEdited: geocodeDebounce.restart()
          onSuggestionHighlighted: function(index) { root.suggestionIndex = index }
          onSuggestionPicked: function(suggestion) { root.pickSuggestion(suggestion) }
        }

        PanelSeparator { width: parent.width }

        AlertControls {
          width: parent.width
          spacing: parent.spacing
          bar: root.bar
          radar: root.radar
          alertsEnabled: root.alertsEnabled
          hasLocation: root.hasLocation
          alertLeadMinutes: root.alertLeadMinutes
          alertRadiusKm: root.alertRadiusKm
          radiusPresets: root.radiusPresets
          alertThreshold: root.alertThreshold
          thresholdOptions: root.thresholdOptions

          onAlertsToggled: {
            var next = !root.alertsEnabled
            root.persistSetting("alertsEnabled", next)
            // Fire the first check immediately so enabling produces a visible
            // result instead of up to ten minutes of silence.
            if (next && root.radar && root.radar.checkNow) Qt.callLater(root.radar.checkNow)
          }
          // The service watches for these and re-checks on its own, so
          // changing a value from the settings form behaves the same as
          // changing it here.
          onRadiusChosen: function(km) { root.persistSetting("alertRadiusKm", km) }
          onThresholdChosen: function(name) { root.persistSetting("alertMinIntensity", name) }
        }
      }
    }
  }
}
