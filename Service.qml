import QtQuick
import Quickshell
import Quickshell.Io
import "RadarModel.js" as RadarModel

// Headless singleton behind the radar plugin.
//
// A bar widget is instantiated once per monitor, so anything that polls has to
// live here instead: the shell mounts exactly one service per plugin, which
// keeps a two-monitor setup from doubling every request.
//
// Two responsibilities:
//
//   1. Own the RainViewer frame manifest, so opening the map does not start
//      from nothing. It is 818 bytes and is only refreshed while something
//      actually needs it. The property is `radarManifest` rather than the
//      obvious `manifest` because the shell assigns the plugin's own
//      manifest.json to any service exposing a property by that name.
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

  function setting(name, fallback) {
    var value = settings ? settings[name] : undefined
    return value === undefined || value === null ? fallback : value
  }

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------

  // A widget is created before its settings are injected, so `settings` is an
  // empty object for the first moments of a session. That state is "not known
  // yet", not "alerts are off", and the two must not be confused: treating it
  // as off makes the arrival of real settings look like the user switching
  // alerts on, which re-arms the alert latch and can announce the same weather
  // twice.
  readonly property bool settingsReady: settings && Object.keys(settings).length > 0
  readonly property bool alertsEnabled: settingsReady && setting("alertsEnabled", false) === true
  readonly property int alertRadiusKm: Math.max(25, Math.min(250, Number(setting("alertRadiusKm", 100)) || 100))
  readonly property string alertThreshold: String(setting("alertMinIntensity", "Heavy"))

  // Storms in most of the world travel somewhere around 50 km/h, so the alert
  // radius doubles as a lead time: 100 km is roughly two hours of warning.
  // Expressing it this way means one setting controls both the ring drawn on
  // the map and how far ahead the forecast is inspected.
  readonly property real assumedStormSpeedKmh: 50
  readonly property int leadMinutes: Math.round(alertRadiusKm / assumedStormSpeedKmh * 60)
  readonly property int forecastSlots: Math.max(4, Math.min(24, Math.ceil(leadMinutes / 15)))

  // ---------------------------------------------------------------------------
  // Location
  // ---------------------------------------------------------------------------

  // Shared with the stock weather widget, which owns the file. Watching it
  // means changing city through the Omarchy menu re-centres the radar live.
  //
  // The watch only reaches as far as the containing directory. On a machine
  // where no weather location was ever set, `~/.local/state/omarchy/settings/`
  // does not exist, so there is nothing to watch and the file appearing later
  // is invisible — hence reloadLocation() below and the retry beneath it.
  property var location: ({ name: "", latitude: null, longitude: null, valid: false })

  readonly property bool hasLocation: location && location.valid === true
  readonly property string locationName: location ? location.name : ""

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

  // Covers the same gap for a file written by something else — the stock
  // weather widget, or `omarchy-weather-location` run in a terminal. Runs only
  // while no location is known and stops for good once one is.
  //
  // Having no location is not necessarily brief: clearing it from this panel
  // removes the file, and committing a typed name with no suggestion chosen
  // stores a name without coordinates, which is deliberately read as no
  // location. Either can last a session, and each tick rebuilds the file
  // watcher as well as reading, so it slows down when nobody is looking at the
  // map — five seconds while the panel is open, a minute otherwise.
  Timer {
    interval: root.frameConsumers > 0 ? 5000 : 60000
    repeat: true
    running: !root.hasLocation
    triggeredOnStart: true
    onTriggered: locationFile.reload()
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
      outlookLevel = 0
      outlookAtClock = ""
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

  // The map calls this while it is open. Refcounted rather than boolean so two
  // monitors showing the panel do not fight over whether polling should stop.
  function acquireManifest() {
    frameConsumers++
    if (!radarManifest) refreshManifest()
  }

  function releaseManifest() {
    frameConsumers = Math.max(0, frameConsumers - 1)
  }

  function refreshManifest() {
    if (manifestProc.running) return
    manifestProc.command = ["curl", "-fsS", "--max-time", "10", RadarModel.MANIFEST_URL]
    manifestProc.running = true
  }

  Process {
    id: manifestProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var parsed = RadarModel.parseManifest(text)
        if (!parsed) {
          // Keep the previous manifest: stale frames still render, and the
          // next tick retries. Blanking the map on one failed request would
          // be a worse outcome than showing data a few minutes old.
          root.frameFailures++
          return
        }
        root.frameFailures = 0
        root.radarManifest = parsed
      }
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
  property double lastCheckTime: 0
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

  readonly property string outlookLabel: levelName(outlookLevel)

  function levelName(level) {
    if (level >= 4) return "Severe"
    if (level >= 3) return "Heavy"
    if (level >= 2) return "Moderate"
    if (level >= 1) return "Light"
    return "Clear"
  }

  function levelValue(name) {
    var normalized = String(name || "").toLowerCase()
    if (normalized === "severe") return 4
    if (normalized === "heavy") return 3
    if (normalized === "moderate") return 2
    if (normalized === "light") return 1
    return 0
  }

  // Bands are rain rate in mm/h, not millimetres per slot. Two reasons: mm/h is
  // the unit the published intensity scale uses, so "heavy" here means what it
  // means elsewhere; and a per-slot figure silently depends on the slot length.
  //
  // The thresholds follow the standard scale — light under 2.5 mm/h, moderate
  // to 7.6, heavy above that — and were checked against the data rather than
  // assumed. Across 2144 forecast samples over the Sahel, the Amazon, the
  // United States, Indonesia and India, wet slots ran to a maximum of 9.6 mm/h
  // with the 99th percentile at 7.6, so Heavy sits where genuinely heavy rain
  // sits and Severe is reserved for a deluge or for the promotion below.
  //
  // Those figures are worth keeping in view when adjusting these: bands set
  // above the range the source actually produces yield an alert that never
  // fires, which is indistinguishable from fair weather and therefore the one
  // failure this plugin cannot afford.
  function levelForPrecipitation(mmPerSlot) {
    var mmPerHour = mmPerSlot * 4
    if (mmPerHour >= 15.0) return 4
    if (mmPerHour >= 7.6) return 3
    if (mmPerHour >= 2.5) return 2
    if (mmPerHour >= 0.5) return 1
    return 0
  }

  // CAPE measures the energy available for convection; gusts measure what the
  // atmosphere is already doing with it. Rain alone does not make weather
  // severe — rain arriving into an unstable airmass does — so this promotes an
  // already-rainy slot one band rather than firing on its own.
  //
  // Calibrated against forecasts for 268 points across the world's convective
  // regions, where gusts reach the 99th percentile at 55 km/h and top out at
  // 63. A rule requiring high gusts *alongside* instability therefore asks for
  // a value the model barely produces and matches almost nothing, so strong
  // instability qualifies on its own at 2000 J/kg, with a second arm for
  // windier setups that are less unstable.
  function severeConditions(cape, gust) {
    return cape >= 2000 || (cape >= 1000 && gust >= 45)
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

    var lats = []
    var lons = []
    for (var i = 0; i < points.length; i++) {
      lats.push(points[i].latitude.toFixed(4))
      lons.push(points[i].longitude.toFixed(4))
    }

    var url = "https://api.open-meteo.com/v1/forecast"
      + "?latitude=" + lats.join(",")
      + "&longitude=" + lons.join(",")
      + "&minutely_15=precipitation,precipitation_probability"
      + "&hourly=cape,wind_gusts_10m"
      + "&forecast_minutely_15=" + forecastSlots
      + "&forecast_hours=" + Math.max(2, Math.ceil(leadMinutes / 60))
      + "&timezone=auto"
    forecastProc.command = ["curl", "-fsS", "--max-time", "12", url]
    forecastProc.running = true
  }

  Process {
    id: forecastProc
    onExited: function(exitCode) {
      root.checking = false
      if (exitCode !== 0) root.consecutiveFailures++
    }
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var raw = String(text || "").trim()
        if (raw === "") return
        var data
        try {
          data = JSON.parse(raw)
        } catch (e) {
          root.consecutiveFailures++
          return
        }
        root.consecutiveFailures = 0
        root.applyForecast(data)
      }
    }
  }

  // Reduce one sampled point to the worst thing it forecasts inside the lead
  // window. Returns null for a response that carries no usable series.
  function summarizePoint(entry, peakCape, peakGust) {
    if (!entry || !entry.minutely_15) return null

    var precipitation = entry.minutely_15.precipitation || []
    var times = entry.minutely_15.time || []

    var level = 0
    var lead = 0
    var peak = 0
    var clock = ""

    for (var i = 0; i < precipitation.length && i < forecastSlots; i++) {
      var mm = Number(precipitation[i]) || 0
      if (mm > peak) peak = mm
      var slotLevel = levelForPrecipitation(mm)
      if (slotLevel === 0) continue
      // Precipitation into an unstable airmass is what turns a shower into a
      // storm; promote one band when the environment supports it.
      if (slotLevel >= 2 && severeConditions(peakCape, peakGust)) slotLevel = Math.min(4, slotLevel + 1)
      if (slotLevel > level) {
        level = slotLevel
        // Index 0 is the 15-minute slot already under way, so it reads as now.
        lead = i * 15
        // Taken from the response rather than computed as now-plus-lead, so
        // the stated time is the model's own slot and cannot drift.
        clock = clockFromTimestamp(times[i])
      }
    }

    return { level: level, lead: lead, peak: peak, clock: clock }
  }

  function peakOf(series) {
    var highest = 0
    if (!series) return highest
    for (var i = 0; i < series.length; i++) highest = Math.max(highest, Number(series[i]) || 0)
    return highest
  }

  function applyForecast(data) {
    // One coordinate returns an object, several return an array. Normalising
    // here keeps the rest of the function indifferent to how many were asked
    // for.
    var entries = Array.isArray(data) ? data : [data]
    if (entries.length === 0) return

    // Instability is a property of the airmass rather than of any one grid
    // cell, so it is taken across the whole sampled area before the bands are
    // applied — the same promotion then holds for every point.
    var peakCape = 0
    var peakGust = 0
    for (var e = 0; e < entries.length; e++) {
      if (!entries[e] || !entries[e].hourly) continue
      peakCape = Math.max(peakCape, peakOf(entries[e].hourly.cape))
      peakGust = Math.max(peakGust, peakOf(entries[e].hourly.wind_gusts_10m))
    }

    // The worst of the sampled points wins, and among equals the soonest. A
    // town is not a point: reporting the centre alone would stay quiet through
    // a storm sitting over the far side of it.
    var worst = null
    var peak = 0
    for (var p = 0; p < entries.length; p++) {
      var summary = summarizePoint(entries[p], peakCape, peakGust)
      if (!summary) continue
      peak = Math.max(peak, summary.peak)
      if (!worst
          || summary.level > worst.level
          || (summary.level === worst.level && summary.lead < worst.lead)) {
        worst = summary
      }
    }
    if (!worst) return

    forecast = data
    outlookCape = peakCape
    outlookGust = peakGust
    outlookPrecipitation = peak
    outlookLeadMinutes = worst.lead
    outlookAtClock = worst.clock
    outlookLevel = worst.level
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
    if (!alertsEnabled) {
      notifiedLevel = 0
      return
    }

    var threshold = levelValue(alertThreshold)

    if (outlookLevel < threshold) {
      // Clear the latch only once conditions drop under the threshold, so a
      // reading that flickers around the boundary cannot re-notify.
      notifiedLevel = 0
      return
    }

    if (outlookLevel <= notifiedLevel) return

    notifiedLevel = outlookLevel
    notify(outlookLevel, outlookLeadMinutes)
  }

  // The figures behind a severe alert, naming only the ones that put it there.
  //
  // A severe reading can arrive by two routes — rain heavy enough on its own,
  // or ordinary rain into an unstable airmass — and each is evidenced by
  // different numbers. Printing all of them regardless produces sentences that
  // argue against themselves: "severe storm, gusts to 17 km/h" reads as a
  // contradiction, because a gust that mild had nothing to do with the verdict.
  // Each figure appears only when it is part of the reason.
  function severityDetail(level) {
    if (level < 4) return ""

    var reasons = []
    var ratePerHour = outlookPrecipitation * 4
    if (ratePerHour >= 15.0) reasons.push("up to " + Math.round(ratePerHour) + " mm/h")
    if (outlookCape >= 2000) reasons.push("CAPE " + Math.round(outlookCape) + " J/kg")
    if (outlookGust >= 45) reasons.push("gusts to " + Math.round(outlookGust) + " km/h")

    return reasons.length > 0 ? " — " + reasons.join(", ") : ""
  }

  function notify(level, lead) {
    var name = levelName(level)

    // Already under way reads differently from on its way. This is the normal
    // case when someone turns alerts on during weather they can already see,
    // where "approaching" would contradict the "starting now" beneath it.
    var underway = lead <= 0
    var headline = level >= 4
      ? (underway ? "Severe storm overhead" : "Severe storm approaching")
      : (underway ? name + " rain now" : name + " rain approaching")

    // Both a relative and an absolute time. The relative one is what the eye
    // wants at the moment the toast appears; the absolute one is what saves it
    // from lying to someone who reads it later, or who was away from the desk
    // when it arrived.
    var whenText = underway ? "under way" : "in about " + humanizeMinutes(lead)
    if (outlookAtClock !== "") whenText += underway ? " since " + outlookAtClock : ", around " + outlookAtClock

    var description = whenText
    if (locationName !== "") description += " at " + locationName
    description += severityDetail(level)

    // How long the toast stays. Omarchy gives a critical popup no expiry and
    // caps everything else at thirty seconds, so "until dismissed" is only
    // reachable through the urgency.
    //
    // Heavy and above therefore go out as critical. The value of an alert
    // lies entirely in the moment nobody was looking, and a timed toast that
    // fires while the desk is empty is a toast that never happened — which is
    // the case the alert exists for. Heavy is also the default threshold, the
    // level this plugin itself calls worth interrupting someone over, so
    // letting it expire unseen would contradict that. The cost is one click.
    //
    // Critical here does not mean emergency. Omarchy only lets a popup through
    // Do Not Disturb when the sender is CLI-style, and this one names itself,
    // so a silenced session files these into history instead of showing
    // them.
    //
    // Moderate and Light stay on the eight-second default. They are worth
    // saying and not worth camping on the screen.
    var persistent = level >= 3
    var command = [
      "omarchy-notification-send",
      "--app-name", "Weather Radar",
      // The same glyph the bar widget wears, so the toast is recognisably
      // from this plugin before a word of it is read.
      "-g", RadarModel.GLYPH,
      "-u", persistent ? "critical" : "normal"
    ]

    // Deliberately no click action. A click on a toast means "I have seen
    // this, go away" to almost everyone, and taking that gesture to open a
    // window instead answers a question the reader did not ask: they have been
    // told it is going to rain, which is the whole point of telling them.
    // Anyone who wants the map opens it themselves.
    notifyProc.command = command.concat([headline, description])
    notifyProc.running = true
  }

  // Open-Meteo returns local ISO timestamps like "2026-08-15T20:15" because
  // the request asks for timezone=auto, so the clock part is already in the
  // user's own time and needs no conversion.
  function clockFromTimestamp(value) {
    var text = String(value || "")
    var marker = text.indexOf("T")
    if (marker === -1) return ""
    return text.substring(marker + 1, marker + 6)
  }

  function humanizeMinutes(minutes) {
    if (minutes < 60) return minutes + " min"
    var hours = Math.floor(minutes / 60)
    var rest = minutes % 60
    if (rest === 0) return hours + "h"
    return hours + "h" + (rest < 10 ? "0" + rest : rest)
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

  Timer {
    id: pollTimer
    interval: root.baseIntervalMs * root.backoffMultiplier
    repeat: true
    running: root.alertsEnabled && root.hasLocation
    triggeredOnStart: true
    onTriggered: {
      root.checkNow()
      // The map wants fresh frames too, but only while someone is looking.
      if (root.frameConsumers > 0 || root.alertsEnabled) root.refreshManifest()
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
      outlookLevel = 0
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
    if (outlookLevel === 0) return "clear"
    // Clock rather than countdown: the label only refreshes when a check runs,
    // so a relative figure would be up to ten minutes out of date on screen,
    // while a time stays correct between checks.
    var when = outlookAtClock !== "" ? outlookAtClock
      : (outlookLeadMinutes <= 0 ? "now" : humanizeMinutes(outlookLeadMinutes))
    return outlookLabel.toLowerCase() + " " + when
  }
}
