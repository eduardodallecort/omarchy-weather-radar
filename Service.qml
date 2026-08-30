import QtQuick
import Quickshell
import Quickshell.Io
import "lib/Glyphs.js" as Glyphs
import "lib/Alerts.js" as Alerts
import "lib/Basemap.js" as Basemap
import "lib/RadarModel.js" as RadarModel
import "lib/Settings.js" as Settings

// Headless singleton behind the radar plugin.
//
// A bar widget is instantiated once per monitor, so anything that polls has to
// live here instead: the shell mounts exactly one service per plugin, which
// keeps a two-monitor setup from doubling every request.
//
// Two responsibilities:
//
//   1. Own the RainViewer frame manifest, so that a two-monitor setup showing
//      the map on both shares one copy instead of fetching one each. It is 818
//      bytes, and is fetched only while the map is open. The property is
//      `radarManifest` rather than the obvious `manifest` because the shell
//      assigns the plugin's own manifest.json to any service exposing a
//      property by that name.
//
//   2. Decide whether to warn about approaching weather, and say so once.
//
// On (2), a note on why the alert reads a point forecast rather than the radar
// image it draws. Distance alone does not mean approaching — a cell 80 km east
// travelling east is not your problem — so a radar-echo alert would have to
// derive motion vectors across frames to avoid crying wolf. The question the
// user is actually asking is "will weather hit me, and how bad", and a point
// forecast answers exactly that, including the instability indices that
// separate ordinary rain from a severe storm. Radar remains the better picture;
// the forecast is the better trigger.
Item {
  id: root

  // Injected by the shell.
  property var shell: null
  property var settings: ({})

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------

  // Coercion lives in Settings.js, which the panel reads through as well.
  // Clamping the same value in two places is two chances to disagree about it,
  // and the pair that would disagree here decides what gets a notification.
  readonly property bool settingsReady: Settings.isReady(settings)
  readonly property bool alertsEnabled: Settings.alertsEnabled(settings)
  readonly property int alertRadiusKm: Settings.alertRadiusKm(settings)
  readonly property string alertThreshold: Settings.alertThreshold(settings)

  // The alert radius doubles as a lead time — the conversion assumes a storm
  // speed, and lives in Alerts.js with the bands it feeds. One setting
  // therefore controls both the ring drawn on the map and how far ahead the
  // forecast is inspected.
  readonly property int leadMinutes: Alerts.leadMinutesFor(alertRadiusKm)
  readonly property int forecastSlots: Alerts.forecastSlotsFor(leadMinutes)

  // ---------------------------------------------------------------------------
  // Location
  // ---------------------------------------------------------------------------

  // Shared with the stock weather widget, which owns the file. Watching it
  // means changing city through the Omarchy menu re-centres the radar live.
  //
  // Read whole, without a ceiling, which is the one place this plugin does
  // that. It is deliberate: this is Omarchy's own state file, read exactly as
  // Omarchy's own weather panel reads it, with the same FileView and the same
  // watch. Reading it through a bounded process instead would mean diverging
  // from the platform on the platform's own file, and losing live updates with
  // it — omarchy-weather-location writes the file and notifies nobody, so the
  // watch is the only mechanism there is. Every stream this plugin owns is
  // bounded; see test/streams.test.js for the inventory.
  //
  // The watch only reaches as far as the containing directory. On a machine
  // where no weather location was ever set, `~/.local/state/omarchy/settings/`
  // does not exist, so there is nothing to watch and the file appearing later
  // is invisible — hence reloadLocation() below and the retry beneath it.
  property var location: ({ name: "", latitude: null, longitude: null, valid: false })

  readonly property bool hasLocation: location && location.valid === true
  readonly property string locationName: location ? location.name : ""

  // "ready", "unresolved" or "unset" — see RadarModel.locationState. The middle
  // one is a name typed with no city picked behind it, which the shared file
  // stores happily and this plugin can do nothing with.
  readonly property string locationState: RadarModel.locationState(location)

  FileView {
    id: locationFile
    path: Quickshell.env("HOME") + "/.local/state/omarchy/settings/weather.json"
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: root.location = RadarModel.parseLocationFile(text())
    onLoadFailed: root.location = RadarModel.parseLocationFile("")
  }

  // Re-read the file now rather than waiting to be told about it. Whoever
  // writes the location calls this immediately afterwards, which is the only
  // way the first one to exist is ever noticed.
  function reloadLocation() {
    locationFile.reload()
  }

  // Covers the one window the file watch cannot: before any location has ever
  // been stored the settings directory does not exist, so a file created in it
  // is invisible. Once the directory exists the watch works — clearing a
  // location only removes the file — so what is needed is a bridge across the
  // start of the very first session, not a permanent watchdog.
  //
  // It runs quickly at first and then slowly forever, rather than stopping.
  // Stopping would strand the machine it exists for: with no directory to
  // watch, a location chosen an hour later from the stock weather widget or a
  // terminal would never be seen, while that widget updated live. A read a
  // minute apart is a file stat, and the burst is never re-armed, because
  // being without a location is otherwise an ordinary long-lived state —
  // clearing it from the panel, or storing a typed name with no coordinates —
  // and re-entering it should not restart rapid polling.
  property int locationRetries: 0
  readonly property int locationRetryBurst: 24

  Timer {
    interval: root.locationRetries < root.locationRetryBurst ? 5000 : 60000
    repeat: true
    running: !root.hasLocation
    triggeredOnStart: true
    onTriggered: {
      if (root.locationRetries < root.locationRetryBurst) root.locationRetries++
      locationFile.reload()
    }
  }

  // Identity of the configured place, and the thing "changed" is measured
  // against.
  //
  // Two properties of the surroundings make the obvious tests wrong. Watching
  // `hasLocation` misses a move, because going from one valid city to another
  // never flips it. Watching the `location` object misfires, because
  // parseLocationFile returns a fresh object on every read and QML notifies on
  // assignment rather than on inequality, so re-reading an unchanged file looks
  // like relocating. Comparing the values is what makes "changed" mean changed.
  property string locationKey: ""

  onLocationChanged: {
    var key = hasLocation ? location.latitude + "," + location.longitude + "|" + locationName : ""
    if (key === locationKey) return

    // Learning where we are is not the same as moving, and only the latter
    // re-arms. Startup can complete a check before this handler runs — the
    // location arrives, a poll fires against it, and the handler then sees a
    // key it has never recorded — so treating an empty previous key as
    // relocation would announce the same weather twice.
    var moved = locationKey !== ""
    locationKey = key

    coverageChecked = false
    hasCoverage = true

    if (moved) {
      // Somewhere new has not been reported on yet. Without this the latch
      // carries across the move, and someone who changes city during weather
      // is told nothing because they were already told about somewhere else.
      notifiedLevel = 0
      discardReading()
    }

    if (hasLocation && alertsEnabled) checkNow()
  }

  // ---------------------------------------------------------------------------
  // RainViewer frame manifest
  // ---------------------------------------------------------------------------

  property var radarManifest: null
  property int frameConsumers: 0
  property int frameFailures: 0

  readonly property var frames: radarManifest ? radarManifest.past : []
  readonly property string tileHost: radarManifest ? radarManifest.host : ""
  readonly property int latestFrameTime: {
    var frame = RadarModel.latestFrame(radarManifest)
    return frame ? frame.time : 0
  }

  // Whether the newest frame in hand is one RainViewer could still improve on.
  // Frames publish about every ten minutes, so one younger than that is the
  // newest that exists, and asking again would return the same bytes.
  //
  // A function rather than a property: the answer depends on the passing of
  // time, and a binding would only be recomputed when the manifest changed —
  // freezing it at "current" for exactly as long as it stayed out of date.
  //
  // A frame that reads as newer than now means the clock moved backwards, not
  // that RainViewer published into the future: an RTC kept in local time, or
  // NTP correcting a drift. Freshness cannot be judged against a clock that
  // just jumped, so the safe answer is to go and ask.
  function manifestIsCurrent() {
    if (!radarManifest) return false
    var age = Date.now() / 1000 - latestFrameTime
    return age >= 0 && age < RadarModel.FRAME_INTERVAL_SEC
  }

  // The map calls these while it is open. Refcounted rather than boolean so two
  // monitors showing the panel do not fight over whether fetching should stop.
  function acquireManifest() {
    frameConsumers++
    loadBasemap()
    refreshManifest()
  }

  function releaseManifest() {
    frameConsumers = Math.max(0, frameConsumers - 1)
  }

  // Every request passes through here, so this is where "is it worth asking"
  // belongs, rather than at each call site. Three reasons not to: one is
  // already in flight, the frames in hand are already the newest published, or
  // the last attempt was too recent to have changed anything.
  readonly property int minFetchGapMs: 60000
  property real lastManifestFetchMs: 0

  function refreshManifest() {
    if (manifestProc.running) return
    if (manifestIsCurrent()) return

    var now = Date.now()
    // As above, in the other direction: a request stamped in the future is a
    // clock that moved, and left alone it would refuse every fetch until real
    // time caught up — hours, on a machine whose RTC was wrong.
    if (lastManifestFetchMs > now) lastManifestFetchMs = 0

    // The floor bounds what opening and closing the map repeatedly can cost,
    // so it guards frames already on screen and waits until there are some.
    // Someone watching an empty map who closes it and opens it again is asking
    // to retry, and a minute of silence is not an answer to that.
    if (radarManifest && lastManifestFetchMs > 0 && now - lastManifestFetchMs < minFetchGapMs) return

    lastManifestFetchMs = now
    manifestProc.answered = false
    manifestProc.command = RadarModel.manifestCommand()
    manifestProc.running = true
  }

  Process {
    id: manifestProc

    // A process that cannot be started emits neither `started` nor `exited`,
    // and goes from running to not running in silence. `exited` fires before
    // `running` drops, so a drop with nothing recorded is a fork that never
    // happened — which has to be answered, or the map waits on a reply that
    // will never come.
    property bool answered: false

    onExited: function(exitCode) {
      answered = true
      root.applyManifestResponse(exitCode, manifestOut.text)
    }
    onRunningChanged: if (!running && !answered) root.applyManifestResponse(-1, "")

    // The collector holds the output and decides nothing. `onStreamFinished`
    // fires before `onExited`, so deciding there is deciding before the exit
    // code exists — and a transfer cut short by the time or size ceiling would
    // be read as one that completed.
    stdout: StdioCollector { id: manifestOut; waitForEnd: true }
  }

  function applyManifestResponse(exitCode, text) {
    // Keep the previous manifest on any failure: stale frames still render,
    // and the next tick retries. Blanking the map on one failed request would
    // be a worse outcome than showing data a few minutes old.
    if (exitCode !== 0) {
      frameFailures++
      return
    }
    var parsed = RadarModel.parseManifest(text)
    if (!parsed) {
      frameFailures++
      return
    }
    frameFailures = 0
    radarManifest = parsed
  }

  // ---------------------------------------------------------------------------
  // Basemap
  // ---------------------------------------------------------------------------

  // The ground the radar is drawn on, decoded once for the whole session.
  //
  // It lives here rather than in the panel for the same reason the frame
  // manifest does: a bar widget is built once per monitor, and two screens
  // showing the map would otherwise each hold their own ten megabytes of
  // coastline. It is read on first use rather than at startup, so a session
  // that never opens the map never pays for it.
  //
  // Data ships with the plugin instead of arriving as tiles. The world's
  // coastlines do not change, and a keyless tile endpoint is a policy rather
  // than a property — the one this plugin used began stamping "API KEY
  // REQUIRED" across every tile in August 2026, for every installation at
  // once, with nothing failing anywhere. Geometry in the repository cannot be
  // withdrawn, and works with no network at all.
  // Also read whole. It is this plugin's own file, inside its own directory:
  // anything able to replace it can replace Service.qml beside it, so a
  // ceiling here would guard nothing. Corruption is handled instead — decode()
  // answers null on anything it cannot read, including a truncated file.
  property var basemap: null
  property bool basemapFailed: false

  function loadBasemap() {
    if (basemap || basemapFile.path !== "") return
    basemapFile.path = Qt.resolvedUrl("data/basemap.bin").toString().replace("file://", "")
  }

  FileView {
    id: basemapFile
    path: ""
    onLoaded: {
      root.basemap = Basemap.decode(basemapFile.data())
      // decode() answers null on anything it cannot read rather than throwing,
      // so a corrupt or truncated file costs the ground layer and nothing else.
      root.basemapFailed = root.basemap === null
      if (root.basemapFailed) console.warn("weather-radar: data/basemap.bin could not be decoded")
    }
    onLoadFailed: {
      root.basemapFailed = true
      console.warn("weather-radar: data/basemap.bin could not be read")
    }
  }

  // ---------------------------------------------------------------------------
  // Radar coverage
  // ---------------------------------------------------------------------------

  // Whether a ground radar reaches the configured location. Large parts of the
  // world have none, and an empty map there reads as a broken plugin unless it
  // says so. Resolved by the panel, which can decode images; the service just
  // remembers the answer.
  property bool coverageChecked: false
  property bool hasCoverage: true

  function reportCoverage(covered) {
    coverageChecked = true
    hasCoverage = covered === true
  }

  // ---------------------------------------------------------------------------
  // Forecast polling
  // ---------------------------------------------------------------------------

  property var forecast: null

  // When a check last produced an outlook, and when one last came back at all.
  // They are different questions: a request that fails, or answers with nothing
  // usable in it, still happened. Without the second, "has not run yet" and
  // "ran and could not tell you anything" look identical from outside — and the
  // failure backoff means the second can last an hour.
  property double lastCheckTime: 0
  property double lastAnswerTime: 0
  property bool checking: false
  property int consecutiveFailures: 0

  // Highest severity found inside the lead window: 0 clear, 1 light, 2
  // moderate, 3 heavy, 4 severe.
  property int outlookLevel: 0
  property int outlookLeadMinutes: 0

  // Wall-clock time the weather is expected, as "HH:MM". A relative figure
  // alone goes stale the moment it is written: a toast that says "in about 2h"
  // is wrong to anyone who reads it forty minutes later, or who walks back to
  // the machine and finds it waiting. The clock time stays true however long
  // the notification sits there.
  property string outlookAtClock: ""
  property real outlookPrecipitation: 0
  property real outlookCape: 0
  property real outlookGust: 0

  readonly property string outlookLabel: Alerts.levelName(outlookLevel)

  // Everything the last check said, dropped together.
  //
  // A reading is about a place and a moment, and `lastCheckTime` is what the
  // panel reads as "there is a reading". Clearing the outlook while leaving the
  // timestamp behind leaves fair weather asserted for a city that has never
  // been checked — which is the exact failure the wording elsewhere exists to
  // prevent, arrived at from the other direction.
  function discardReading() {
    outlookLevel = 0
    outlookLeadMinutes = 0
    outlookAtClock = ""
    outlookPrecipitation = 0
    outlookCape = 0
    outlookGust = 0
    lastCheckTime = 0
  }

  // Retried from the panel when it opens. See Alerts.shouldRetryForecast for
  // why only a failing check is retried.
  //
  // Seconds rather than the minute the manifest uses. The person this exists
  // for has just reconnected and reopened the panel, which is a thing that
  // happens well inside a minute — a floor long enough to catch them would
  // refuse the one retry that was actually asked for. Overlapping requests are
  // already impossible, so all this bounds is a burst from opening and closing
  // repeatedly, and only while checks are failing, which is usually while there
  // is no network for them to leave on.
  readonly property int minRetryGapMs: 10000

  function refreshIfStale() {
    if (!alertsEnabled || !hasLocation || checking) return
    if (!Alerts.shouldRetryForecast({
      now: Date.now(),
      lastAnswer: lastAnswerTime,
      lastReading: lastCheckTime,
      failing: consecutiveFailures > 0,
      floor: minRetryGapMs,
      cadence: RadarModel.FORECAST_INTERVAL_SEC * 1000
    })) return
    checkNow()
  }

  function checkNow() {
    if (!hasLocation || checking) return

    // Read the coordinates once and confirm they are numbers before building a
    // request out of them. `hasLocation` is derived from a property that other
    // code reassigns, and a plugin reload landing between the two has been seen
    // to reach this with nulls.
    //
    // parseFloat, not Number: an unset location carries null, Number(null) is
    // 0, and a request built from that would quietly report the weather at
    // 0°N 0°E — an alert naming no city, about an ocean. Failing loudly beats
    // answering confidently about the wrong hemisphere.
    var lat = parseFloat(location.latitude)
    var lon = parseFloat(location.longitude)
    if (!isFinite(lat) || !isFinite(lon)) return

    checking = true

    // Five coordinates rather than one: the centre and four points 5 km out.
    // See RadarModel.samplePoints — the model grid is coarse enough that a
    // stored coordinate speaks for an arbitrary patch beside it rather than
    // for the town it names. They all travel in one request.
    var points = RadarModel.samplePoints(lat, lon)
    if (points.length === 0) {
      // Unreachable given the check above, but a guard that returns without
      // clearing `checking` would block every later check for the session.
      checking = false
      return
    }

    forecastProc.answered = false
    forecastProc.command = RadarModel.forecastCommand(
      points, forecastSlots, Math.max(2, Math.ceil(leadMinutes / 60)))
    forecastProc.running = true
  }

  Process {
    id: forecastProc

    // See manifestProc. `checking` is cleared only from here, so a fork that
    // never happened would leave it set and every later check would return at
    // the door — the alert silently stopping for the rest of the session.
    property bool answered: false

    // Set when this service stops the process itself. The exit code that
    // follows is a cancellation, and counting it would inflate the failure
    // backoff and tell the user the forecast cannot be reached because they
    // turned the alerts off.
    property bool cancelled: false

    onExited: function(exitCode) {
      answered = true
      if (cancelled) {
        cancelled = false
        root.checking = false
        return
      }
      root.applyForecastResponse(exitCode, forecastOut.text)
    }
    onRunningChanged: {
      if (running || answered) return
      if (cancelled) {
        cancelled = false
        root.checking = false
        return
      }
      root.applyForecastResponse(-1, "")
    }

    stdout: StdioCollector { id: forecastOut; waitForEnd: true }
  }

  function applyForecastResponse(exitCode, text) {
    checking = false
    lastAnswerTime = Date.now()

    if (exitCode !== 0) {
      consecutiveFailures++
      return
    }

    var raw = String(text || "").trim()
    if (raw === "") {
      consecutiveFailures++
      return
    }

    var data
    try {
      data = JSON.parse(raw)
    } catch (e) {
      consecutiveFailures++
      return
    }

    consecutiveFailures = 0
    applyForecast(data)
  }

  function applyForecast(data) {
    var outlook = Alerts.summarizeForecast(data, forecastSlots)
    // Null means the response carried nothing usable. Keeping the previous
    // outlook is right; overwriting it with zeros would report fair weather on
    // the strength of a broken response.
    if (!outlook) return

    forecast = data
    outlookCape = outlook.cape
    outlookGust = outlook.gust
    outlookPrecipitation = outlook.precipitation
    outlookLeadMinutes = outlook.leadMinutes
    outlookAtClock = outlook.clock
    outlookLevel = outlook.level
    lastCheckTime = Date.now()

    evaluateAlert()
  }

  // ---------------------------------------------------------------------------
  // Alerting
  // ---------------------------------------------------------------------------

  // The level the user was last told about. Held until conditions clear so a
  // storm that lingers for three hours does not notify eighteen times, while a
  // situation that worsens still escalates.
  property int notifiedLevel: 0

  function evaluateAlert() {
    var decision = Alerts.decideNotification(outlookLevel, notifiedLevel, alertThreshold, alertsEnabled)
    notifiedLevel = decision.notifiedLevel
    if (decision.notify) notify()
  }

  function notify() {
    var text = Alerts.notificationText({
      level: outlookLevel,
      leadMinutes: outlookLeadMinutes,
      clock: outlookAtClock,
      precipitation: outlookPrecipitation,
      cape: outlookCape,
      gust: outlookGust
    }, locationName)

    // Deliberately no click action. A click on a toast means "I have seen
    // this, go away" to almost everyone, and taking that gesture to open a
    // window instead answers a question the reader did not ask: they have been
    // told it is going to rain, which is the whole point of telling them.
    notifyProc.command = [
      "omarchy-notification-send",
      "--app-name", "Weather Radar",
      // The same glyph the bar widget wears, so the toast is recognisably from
      // this plugin before a word of it is read.
      "-g", Glyphs.RADAR,
      "-u", text.urgency,
      text.headline,
      text.description
    ]
    notifyProc.running = true
  }

  Process {
    id: notifyProc
  }

  // ---------------------------------------------------------------------------
  // Scheduling
  // ---------------------------------------------------------------------------

  // RainViewer publishes a frame every ten minutes and the forecast model
  // updates no faster, so this is both the floor and the natural cadence.
  // Backing off on repeated failure keeps a network outage from turning into a
  // tight retry loop inside a process that lives all day.
  readonly property int baseIntervalMs: RadarModel.FRAME_INTERVAL_SEC * 1000
  readonly property int backoffMultiplier: Math.min(6, Math.pow(2, Math.min(consecutiveFailures, 3)))

  // Two things want this cadence, and either one on its own is reason enough to
  // run: the alert check, which needs a location, and the map, which needs to
  // be open.
  //
  // The backoff belongs to the alert check alone, because only the forecast can
  // raise it, and it stands down while the map is open. Nothing about
  // api.open-meteo.com refusing — a rate limit, a bad DNS answer, an outage of
  // that one host — says anything about RainViewer, and stretching the map's
  // cadence to an hour on that evidence would freeze the picture in front of
  // someone who is watching it. With nobody watching, an hour between attempts
  // is the right courtesy to a service having a bad day.
  Timer {
    id: pollTimer
    readonly property bool alerting: root.alertsEnabled && root.hasLocation
    readonly property bool watched: root.frameConsumers > 0
    interval: root.baseIntervalMs * (alerting && !watched ? root.backoffMultiplier : 1)
    repeat: true
    running: alerting || watched
    triggeredOnStart: true
    onTriggered: {
      if (alerting) root.checkNow()
      // Frames serve the map and nothing else, so a closed map is not a reason
      // to fetch them — including for the alert, which reads the forecast.
      if (watched) root.refreshManifest()
    }
  }

  // Changing the threshold or the radius is as deliberate as flipping the
  // toggle, and deserves the same answer: re-arm and report the current state
  // rather than leaving the user to wonder for up to ten minutes.
  //
  // The two need different work. A new threshold only changes the question,
  // and the reading in hand still answers it, so it is re-evaluated in place.
  // A new radius moves the lead window, which means the held reading is about
  // the wrong horizon and has to be fetched again.
  //
  // Both are ignored the first time they settle, because settings arrive after
  // the service is constructed: their initial jump from defaults to stored
  // values is startup, not a decision.
  property string appliedThreshold: ""
  property int appliedRadius: 0

  onAlertThresholdChanged: applyAlertConfig()
  onAlertRadiusKmChanged: applyAlertConfig()
  onSettingsReadyChanged: applyAlertConfig()

  // Coalesced to the end of the turn. Bindings re-evaluate one at a time, so a
  // single settings arrival moves the radius and the threshold in separate
  // steps; comparing at each step would record the first as the baseline and
  // read the second as a decision nobody made. Qt.callLater collapses repeated
  // calls into one, so the comparison sees a settled state.
  function applyAlertConfig() {
    Qt.callLater(syncAlertConfig)
  }

  function syncAlertConfig() {
    if (!settingsReady) return

    var first = appliedThreshold === ""
    var thresholdMoved = !first && appliedThreshold !== alertThreshold
    var radiusMoved = !first && appliedRadius !== alertRadiusKm

    appliedThreshold = alertThreshold
    appliedRadius = alertRadiusKm

    if (first || (!thresholdMoved && !radiusMoved)) return

    notifiedLevel = 0
    if (radiusMoved) {
      if (hasLocation && alertsEnabled) checkNow()
    } else {
      evaluateAlert()
    }
  }

  // Turning alerts off must actually stop the work, not merely hide it.
  onAlertsEnabledChanged: {
    if (!alertsEnabled) {
      notifiedLevel = 0
      discardReading()
      // Stopping the process produces an exit code, and it is not an outage.
      if (forecastProc.running) forecastProc.cancelled = true
      forecastProc.running = false
      checking = false
    } else if (hasLocation) {
      checkNow()
    }
  }

  // ---------------------------------------------------------------------------
  // Summary for the bar
  // ---------------------------------------------------------------------------

  readonly property string barSummary: {
    if (!hasLocation) return ""
    if (!alertsEnabled) return ""
    // No reading at all while checks are failing is not fair weather. "clear"
    // there would be the plugin's own silence dressed up as an answer.
    if (lastCheckTime <= 0) return consecutiveFailures > 0 ? "unavailable" : ""
    if (outlookLevel === 0) return "clear"
    // Clock rather than countdown: the label only refreshes when a check runs,
    // so a relative figure would be up to ten minutes out of date on screen,
    // while a time stays correct between checks.
    var when = outlookAtClock !== "" ? outlookAtClock
      : (outlookLeadMinutes <= 0 ? "now" : Alerts.humanizeMinutes(outlookLeadMinutes))
    return outlookLabel.toLowerCase() + " " + when
  }
}
