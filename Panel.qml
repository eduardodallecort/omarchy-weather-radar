import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "ui"
import "lib/Alerts.js" as Alerts
import "lib/Frames.js" as Frames
import "lib/Settings.js" as Settings
import "lib/TileMath.js" as TileMath
import "lib/RadarModel.js" as RadarModel
import "lib/TileCache.js" as TileCache

// The radar panel.
//
// Opens centred on the location Omarchy already knows about, stacks the latest
// radar frame over a basemap, and can play the last two hours as a loop. The
// alert toggle lives down here, so turning the watch on is one click from the
// thing you are looking at, the way the audio panel keeps its mute switch
// beside the thing it mutes — and because a schema entry is not an interface:
// nothing in the installed shell renders one, so a control that is not in a
// panel is nowhere. See Settings.js.
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
  readonly property string locationState: radar ? radar.locationState : "unset"

  property real viewLatitude: 0
  property real viewLongitude: 0
  property int zoom: Settings.defaultZoom(settings)

  // The map's own height, declared once because the limit on how far north or
  // south the view may sit is a question about the viewport rather than about
  // the centre: half a panel of world has to stay on each side of it.
  readonly property real mapHeight: Style.space(320)

  // Reapplied on zoom as well as on panning. Zooming out makes the same panel
  // cover more of the globe, so a centre that was legal deep in stops being
  // legal — and without this, zooming out near a pole puts the world's edge
  // across the middle of the map with nothing beyond it.
  onZoomChanged: viewLatitude = TileMath.constrainLatitude(viewLatitude, zoom, mapHeight)

  // The radar layer stops requesting new detail here and gets scaled up
  // instead, so the basemap can keep sharpening past the data's limit.
  readonly property int radarSourceZoom: Math.min(zoom, RadarModel.MAX_RADAR_ZOOM)
  readonly property bool radarUpscaled: zoom > RadarModel.MAX_RADAR_ZOOM

  function recenter() {
    // Nothing to centre on before a location exists; recentring on the
    // placeholder would move the view to 0,0 rather than leave it alone.
    if (!hasLocation) return
    viewLatitude = TileMath.constrainLatitude(homeLatitude, zoom, mapHeight)
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
    locationSaveProc.answered = false
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
    geocodeProc.answered = false
    geocodeProc.command = RadarModel.geocodingCommand(geocodeActiveQuery, 5)
    geocodeProc.running = true
  }

  Timer {
    id: geocodeDebounce
    interval: 220
    onTriggered: root.requestGeocode()
  }

  Process {
    id: geocodeProc

    // A process that cannot be started emits neither `started` nor `exited`.
    // Without an answer the search field would keep whatever suggestions it
    // had and never ask again for the query the user has since typed.
    property bool answered: false

    onExited: function(exitCode) {
      answered = true
      root.applyGeocodeResponse(exitCode, geocodeOut.text)
    }
    onRunningChanged: if (!running && !answered) root.applyGeocodeResponse(-1, "")

    // The collector holds the output and decides nothing: `onStreamFinished`
    // runs before the exit code exists, so a search cut short by the time or
    // size ceiling would be read as a search that found nothing.
    stdout: StdioCollector { id: geocodeOut; waitForEnd: true }
  }

  function applyGeocodeResponse(exitCode, text) {
    // A failed search leaves no suggestions rather than stale ones: a list
    // from the previous query, under the letters just typed, is a wrong answer
    // presented as a current one.
    root.locationSuggestions = (exitCode === 0 && root.editingLocation)
      ? RadarModel.parseGeocodingResults(text) : []
    root.suggestionIndex = 0

    // Only when there is still a search to run. cancelEditingLocation() clears
    // the pending query, and a successful save routes through it too — so a
    // request in flight when the user presses Escape would come back, find
    // pending and active different, and go out again for the empty string:
    // a real call to the geocoder for nothing, after the field is closed.
    if (!root.editingLocation || root.geocodePendingQuery === "") return
    if (root.geocodePendingQuery !== root.geocodeActiveQuery) Qt.callLater(root.startGeocode)
  }

  Process {
    id: locationSaveProc

    // See geocodeProc. `savingLocation` is cleared only from here, so a fork
    // that never happened would leave the spinner turning and the field
    // disabled for as long as the panel lives.
    property bool answered: false

    onExited: function(exitCode) {
      answered = true
      root.applyLocationSave(exitCode)
    }
    onRunningChanged: if (!running && !answered) root.applyLocationSave(-1)
  }

  function applyLocationSave(exitCode) {
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

  // ---------------------------------------------------------------------------
  // Frames
  // ---------------------------------------------------------------------------

  readonly property var frames: radar ? radar.frames : []
  property int frameIndex: 0
  property bool playing: false

  // What the user is looking at, expressed so that it survives the list being
  // replaced: the moment on screen, and whether they chose to follow the newest
  // frame. Both are recorded while the list that produced them is still in
  // hand — an index into the old list means nothing in the new one, and the
  // panel outlives many replacements.
  property real shownTime: 0
  property bool followingLatest: true

  // Bumped whenever the list is replaced. At an unchanged index a new manifest
  // is still a different frame, and without this the radar layers keep the
  // tiles they already have.
  property int frameEpoch: 0

  readonly property var currentFrame: {
    var index = Frames.clampIndex(frames, frameIndex)
    return index < 0 ? null : frames[index]
  }

  readonly property string frameLabel: currentFrame ? RadarModel.formatFrameTime(currentFrame.time) : "--:--"
  readonly property bool isLatestFrame: Frames.isLatest(frames, frameIndex)

  // Jump to the newest frame in hand, and follow it from here. What "newest"
  // means is decided again each time the list is replaced, so this holds even
  // when the list on screen is hours old and the real one has not arrived yet.
  function showLatestFrame() {
    followingLatest = true
    var latest = frames.length - 1
    if (latest >= 0 && frameIndex !== latest) frameIndex = latest
    else recordShownFrame()
  }

  function recordShownFrame() {
    var frame = currentFrame
    shownTime = frame ? frame.time : 0
    followingLatest = Frames.isLatest(frames, frameIndex)
  }

  // A new manifest arrives every ten minutes, and the panel is opened against
  // lists it has never seen. Someone parked on the newest frame wants the
  // newest frame whatever the new list looks like; someone who scrubbed back to
  // a time wants that time, at whatever index it now sits.
  onFramesChanged: {
    if (frames.length === 0) return
    frameEpoch++

    var next = Frames.reselect(frames, shownTime, followingLatest)
    if (next !== frameIndex) {
      frameIndex = next
    } else {
      // The same position in a different list is a different frame, so the
      // layers are told even though the index did not move.
      showFrame(frameIndex)
      recordShownFrame()
    }

    if (frameA === 0 && frameIndex >= 0) { frameA = frames[frameIndex].time; frontIsA = true }
  }

  // Crossfade state. Two radar layers alternate: the incoming frame is loaded
  // into whichever is currently behind, then the two swap opacity. Hard-cutting
  // between frames reads as a flicker, because consecutive radar frames differ
  // enough that the eye registers the swap rather than the motion.
  //
  // Each layer holds the moment of the frame it shows, 0 for none, and not its
  // position in the list. A new list is the old one shifted by a frame, and a
  // layer holding a position would switch to the frame beside it the moment
  // the list arrived, on screen and with no crossfade, before that frame's
  // tiles were even there.
  property real frameA: 0
  property real frameB: 0
  property bool frontIsA: true

  onFrameIndexChanged: {
    showFrame(frameIndex)
    recordShownFrame()
    nearTileTimer.restart()
  }

  function showFrame(index) {
    if (index < 0 || index >= frames.length) return
    var time = frames[index].time
    // A swap still waiting for its tiles: the new frame replaces the one it
    // was waiting for, in the same incoming layer, instead of going into the
    // layer on screen.
    if (mapView.swapPending) {
      if (frontIsA) frameA = time
      else frameB = time
      return
    }
    if (frontIsA) frameB = time
    else frameA = time
    frontIsA = !frontIsA
  }

  // Where a layer loads one tile from: the service's copy on disk, or null
  // while it is still on the way. Straight from the network only when there
  // is nowhere safe to keep a cache.
  function radarTileUrlForTime(time, z, x, y) {
    if (!root.radar || !root.radar.tileHost) return ""
    var index = Frames.indexOfTime(root.frames, time)
    if (index < 0) return ""
    var frame = root.frames[index]
    if (root.radar.tileCacheState === "off") {
      return RadarModel.tileUrl(root.radar.tileHost, frame.path, 256,
        z, x, y, root.colorSchemeId, root.smoothTiles, root.showSnow)
    }
    var key = TileCache.tileKey(frame.time, z, x, y, root.colorSchemeId, root.smoothTiles, root.showSnow)
    return key === "" ? "" : root.radar.tileSource(key)
  }

  Timer {
    id: playbackTimer
    // Slow enough to read the motion rather than watch a strobe, with a longer
    // hold on the newest frame so the loop ends on the picture that matters
    // and the restart is legible as a restart. While it is waiting on the next
    // frame's tiles it checks often, so it moves on as soon as they are in.
    interval: root.playbackHeldSince > 0 ? 100 : (root.isLatestFrame ? 1500 : 550)
    repeat: true
    running: root.playing && root.opened && root.frames.length > 1
    onTriggered: {
      var next = Frames.nextIndex(root.frames, root.frameIndex)
      var now = Date.now()
      if (!root.frameTilesReady(next)) {
        // A clock that moved backwards restarts the wait rather than making
        // it last until the clock catches up.
        if (root.playbackHeldSince === 0 || root.playbackHeldSince > now) root.playbackHeldSince = now
        if (now - root.playbackHeldSince < TileCache.PLAYBACK_HOLD_MAX_MS) return
      }
      root.playbackHeldSince = 0
      root.frameIndex = next
    }
  }

  // When the loop started waiting on the next frame's tiles, or 0 when it is
  // not waiting. See TileCache.frameReady.
  property real playbackHeldSince: 0

  // Whether the tiles of a frame in view are all in, or failing and not worth
  // waiting for. Not while the cache is being emptied, which it is refilled
  // after. Always, when there is no cache to ask, since then nothing can tell.
  function frameTilesReady(index) {
    if (!radar || radar.tileCacheState === "off") return true
    if (radar.tileCacheState !== "ready") return false
    if (index < 0 || index >= frames.length) return true
    var frame = frames[index]
    var states = []
    for (var i = 0; i < viewTiles.length; i++) {
      var key = TileCache.tileKey(frame.time, radarSourceZoom, viewTiles[i].x, viewTiles[i].y,
        colorSchemeId, smoothTiles, showSnow)
      if (key !== "") states.push(radar.tileState(key))
    }
    return TileCache.frameReady(states)
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
    root.playing = false
    if (root.editingLocation) root.cancelEditingLocation()
    if (root.radar && root.manifestHeld) {
      root.radar.releaseManifest(root.tileOwner)
      root.manifestHeld = false
    }
    root.controller.hide()
    setCenterHoverRevealSuppressed(false)
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
    if (manifestHeld && root.radar && root.radar.releaseManifest) root.radar.releaseManifest(root.tileOwner)
  }

  function onOpened() {
    // Opening is a question about now, so the view and the clock both start
    // there. Wherever the map was left, and whatever moment was on the
    // timeline, is where somebody was looking once — not where they are asking
    // to look now. A moment scrubbed to two hours ago may not even be published
    // any more, and the nearest surviving frame to it is the oldest one in the
    // window: the furthest from the question being asked.
    //
    // While the panel is open the opposite holds, and Frames.reselect keeps
    // whoever is studying a particular time on that time as the list moves
    // under them.
    panned = false
    if (hasLocation) recenter()
    showLatestFrame()
    if (root.radar && !manifestHeld) {
      root.radar.acquireManifest()
      manifestHeld = true
    }

    // Opening the map is a request for current information, and the frames are
    // not the only thing that can have gone stale or started failing while it
    // was closed.
    if (root.radar && root.radar.refreshIfStale) root.radar.refreshIfStale()

    // Every tile asks again where it is to be loaded from. Opening the map
    // retries the tiles that failed while it was closed (see the service's
    // retryFailedTiles), and the layers have to notice.
    frameEpoch++
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
    if (root.bar && typeof root.bar.setCenterHoverRevealSuppressed === "function") {
      root.bar.setCenterHoverRevealSuppressed(value)
    } else if (root.bar && "centerHoverRevealSuppressed" in root.bar) {
      try { root.bar.centerHoverRevealSuppressed = value } catch (_) {}
    }
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

  // The ground is drawn from geometry that ships with the plugin, decoded once
  // by the service. See ui/BasemapLayer.qml for why its colours follow the
  // theme while the radar's do not.
  readonly property var basemap: radar ? radar.basemap : null

  // Credit for everything drawn on the map, in one place so it cannot fall out
  // of step with where the data actually comes from.
  readonly property string attribution: "RainViewer · Natural Earth"

  function radarTileUrlA(z, x, y) { return root.radarTileUrlForTime(root.frameA, z, x, y) }
  function radarTileUrlB(z, x, y) { return root.radarTileUrlForTime(root.frameB, z, x, y) }

  // The radar tiles covering the view, at the zoom the radar is fetched at.
  readonly property var viewTiles: {
    var scale = Math.pow(2, zoom - radarSourceZoom)
    return TileCache.viewTiles(viewLatitude, viewLongitude, radarSourceZoom,
      mapView.width / scale, mapHeight / scale)
  }

  // Which of this map's requests are its own, for the service that shares one
  // queue between the maps on every monitor.
  readonly property string tileOwner: String(root)

  // Tells the service which tiles to fetch for what is on screen. The frame
  // shown and the one after it are asked for as soon as the view stops
  // moving, which is all a paused map or one scrubbed by hand needs. The rest
  // of the loop only while it plays, and only once the view has stayed put
  // for a second: someone dragging across a country stops many times on the
  // way, and fetching thirteen frames at every stop would be most of what the
  // plugin ever asks RainViewer for.
  readonly property string loopTileView: [
    opened, frameEpoch, radar ? radar.tileHost : "", radar ? radar.tileCacheState : "",
    viewLatitude.toFixed(5), viewLongitude.toFixed(5), zoom, radarSourceZoom,
    mapView.width, mapHeight, colorSchemeId, smoothTiles, showSnow
  ].join("|")
  property bool loopTilesSettled: false
  onLoopTileViewChanged: {
    loopTilesSettled = false
    nearTileTimer.restart()
    wholeLoopTimer.restart()
  }

  Timer {
    id: nearTileTimer
    interval: 80
    onTriggered: root.requestLoopTiles()
  }

  Timer {
    id: wholeLoopTimer
    interval: 1000
    onTriggered: {
      root.loopTilesSettled = true
      root.requestLoopTiles()
    }
  }

  // From the frame on screen onwards, so that a playing loop meets tiles that
  // have already arrived. Asked again as the frame moves, which reorders the
  // same request rather than adding to it.
  onPlayingChanged: {
    playbackHeldSince = 0
    nearTileTimer.restart()
  }

  // What the map shows of that. Loading is said only once it has lasted a
  // moment: most tiles arrive within a fraction of a second of a pan, and a
  // line that flashed up at every drag would be noise. A failure is said at
  // once.
  property string shownNotice: ""
  onRadarNoticeChanged: {
    if (radarNotice === TileCache.NOTICE_LOADING && shownNotice === "") {
      loadingNoticeDelay.restart()
    } else {
      loadingNoticeDelay.stop()
      shownNotice = radarNotice
    }
  }
  Timer {
    id: loadingNoticeDelay
    interval: 400
    onTriggered: root.shownNotice = root.radarNotice
  }

  // Tiles are asked for once a request for the frame list in flight has
  // answered: see the service's manifestPending.
  readonly property bool manifestPending: radar ? radar.manifestPending === true : false
  onManifestPendingChanged: if (!manifestPending) nearTileTimer.restart()

  function requestLoopTiles() {
    if (!root.radar || !root.opened || root.radar.tileCacheState === "off") return
    if (root.manifestPending) return
    var whole = root.loopTilesSettled && root.playing
    var count = whole ? root.frames.length : Math.min(2, root.frames.length)
    root.radar.wantTiles(root.tileOwner, TileCache.loopJobs(root.radar.tileHost, root.frames,
      root.frameIndex, root.viewTiles, root.radarSourceZoom, root.colorSchemeId,
      root.smoothTiles, root.showSnow, count))
  }

  // What the map says about the frame on screen: loading while its tiles are
  // arriving or the cache is being emptied, and why when they cannot be got,
  // RainViewer limiting requests or anything else failing. Nothing once they
  // are all on disk; see TileCache.radarNotice.
  readonly property string radarNotice: {
    if (!radar || !opened || radar.tileCacheState === "off") return ""
    if (frameIndex < 0 || frameIndex >= frames.length) return ""
    if (radar.tileCacheState !== "ready") return TileCache.NOTICE_LOADING
    var unused = radar.tileRevision + radar.tilesPausedUntil
    var frame = frames[frameIndex]
    var states = []
    for (var i = 0; i < viewTiles.length; i++) {
      var key = TileCache.tileKey(frame.time, radarSourceZoom, viewTiles[i].x, viewTiles[i].y,
        colorSchemeId, smoothTiles, showSnow)
      if (key !== "") states.push(radar.tileState(key))
    }
    return TileCache.radarNotice(states)
  }

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
          id: mapView
          width: parent.width
          height: root.mapHeight
          bar: root.bar
          basemap: root.basemap

          centerLatitude: root.viewLatitude
          centerLongitude: root.viewLongitude
          zoom: root.zoom
          radarSourceZoom: root.radarSourceZoom

          radarTileUrlA: root.radarTileUrlA
          radarTileUrlB: root.radarTileUrlB

          frameA: root.frameA
          frameB: root.frameB
          frameEpoch: root.frameEpoch
          frontIsA: root.frontIsA
          colorSchemeId: root.colorSchemeId
          smoothTiles: root.smoothTiles

          hasLocation: root.hasLocation
          homeLatitude: root.homeLatitude
          homeLongitude: root.homeLongitude
          alertsEnabled: root.alertsEnabled
          alertRadiusKm: root.alertRadiusKm

          loading: root.frames.length === 0
          radarUnavailable: root.radar ? root.radar.frameFailures > 0 : false
          notice: root.shownNotice
          onTileFailed: function(source) {
            if (root.radar && root.radar.tileUnreadable) root.radar.tileUnreadable(source)
          }
          attribution: root.attribution

          onDragged: function(latitude, longitude) {
            root.viewLatitude = TileMath.constrainLatitude(latitude, root.zoom, root.mapHeight)
            // Normalised as it is stored, so panning east indefinitely keeps
            // the centre a real coordinate rather than letting it grow without
            // bound. The ground draws the world repeatedly either way; this is
            // about what everything else positioned against the centre sees.
            root.viewLongitude = TileMath.wrapLongitude(longitude)
            root.panned = true
          }
          onRecenterRequested: {
            root.panned = false
            root.recenter()
          }
          onZoomRequested: function(zoom, latitude, longitude) {
            root.zoom = zoom
            var wrapped = TileMath.wrapLongitude(longitude)
            // Zooming towards the pointer moves the view, so it counts as
            // panning — otherwise the next location update would snap the map
            // back. Zooming on the centre moves nothing and must not.
            var constrained = TileMath.constrainLatitude(latitude, zoom, root.mapHeight)
            if (!TileMath.samePosition(constrained, wrapped, root.viewLatitude, root.viewLongitude)) {
              root.viewLatitude = constrained
              root.viewLongitude = wrapped
              root.panned = true
            }
          }

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

        // Separator, then a small-caps heading at the content edge, then the
        // rows inset under it. That rail is the shape every dense first-party
        // panel is built on — audio, network, power, bluetooth — and without
        // it a panel reads as a stack of controls rather than as one of theirs.
        PanelSectionHeader {
          text: "LOCATION"
          foreground: root.bar ? root.bar.foreground : Color.foreground
          fontFamily: Style.font.family
        }

        LocationPicker {
          id: locationPicker
          width: parent.width
          spacing: Style.space(6)
          bar: root.bar
          locationName: root.locationName
          locationState: root.locationState
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
          // Sections need more air between them than rows do inside one.
          spacing: Style.space(12)
          bar: root.bar
          radar: root.radar
          alertsEnabled: root.alertsEnabled
          locationState: root.locationState
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
          // The service watches for these and re-checks on its own, so a
          // value edited into shell.json by hand behaves the same as one
          // chosen here.
          onRadiusChosen: function(km) { root.persistSetting("alertRadiusKm", km) }
          onThresholdChosen: function(name) { root.persistSetting("alertMinIntensity", name) }
        }
      }
    }
  }
}
