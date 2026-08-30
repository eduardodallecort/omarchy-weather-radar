// Storm alerting: intensity bands, forecast reduction, the notification latch,
// when to ask again, and every word that reaches the user — in the toast and in
// the line under the switch alike.
//
// This is the part of the plugin that decides whether someone is woken at
// three in the morning, and the part whose thresholds were recalibrated once
// already. Every rule here is a pure function over plain values so it can be
// pinned by a test, which is the only thing standing between a miscalibration
// and an alert that silently never fires.
//
// Forecast data comes from Open-Meteo: `minutely_15.precipitation` in
// millimetres per 15-minute slot, `hourly.cape` in J/kg and
// `hourly.wind_gusts_10m` in km/h.

.pragma library

// ---------------------------------------------------------------------------
// Severity levels
// ---------------------------------------------------------------------------

var CLEAR = 0
var LIGHT = 1
var MODERATE = 2
var HEAVY = 3
var SEVERE = 4

// The values offered as an alert threshold. "Clear" is deliberately absent:
// there is no such thing as being notified that nothing is happening.
var THRESHOLD_OPTIONS = ["Light", "Moderate", "Heavy", "Severe"]

function levelName(level) {
  if (level >= SEVERE) return "Severe"
  if (level >= HEAVY) return "Heavy"
  if (level >= MODERATE) return "Moderate"
  if (level >= LIGHT) return "Light"
  return "Clear"
}

function levelValue(name) {
  var normalized = String(name || "").toLowerCase()
  if (normalized === "severe") return SEVERE
  if (normalized === "heavy") return HEAVY
  if (normalized === "moderate") return MODERATE
  if (normalized === "light") return LIGHT
  return CLEAR
}

// ---------------------------------------------------------------------------
// Bands
// ---------------------------------------------------------------------------

// Rain rate in millimetres per hour, not per slot. Two reasons: mm/h is the
// unit the published intensity scale uses, so "heavy" here means what it means
// elsewhere; and a per-slot figure silently depends on the slot length.
//
// Three of these sit on the published scale. The lowest deliberately does not.
// Open-Meteo reports precipitation rounded to a tenth of a millimetre per slot,
// so the smallest rain it can express is 0.1 mm in a quarter of an hour — 0.4
// mm/h — and the scale's drizzle boundary of 0.5 mm/h falls in the gap above
// it. A band there is above every reading the source can produce at the bottom
// of its range: of 1728 slots sampled across eighteen convective regions, 446
// were wet and 265 of those were exactly one step, so 59% of the rain the
// source reported was being classified as no rain at all. 0.3 is below one
// step and above zero, which makes the lowest band mean "the source reported
// rain" — and keeps the comparison away from a boundary the data lands on.
var RATE_LIGHT = 0.3
var RATE_MODERATE = 2.5
var RATE_HEAVY = 7.6
var RATE_SEVERE = 15.0

// Open-Meteo's minutely_15 series is millimetres accumulated in a quarter of
// an hour, so four of them make an hour.
var SLOTS_PER_HOUR = 4
var SLOT_MINUTES = 15

function ratePerHour(mmPerSlot) {
  return mmPerSlot * SLOTS_PER_HOUR
}

// The thresholds follow the standard scale — light under 2.5 mm/h, moderate to
// 7.6, heavy above that — and were checked against the data rather than
// assumed. Across 2144 forecast samples over the Sahel, the Amazon, the United
// States, Indonesia and India, wet slots ran to a maximum of 9.6 mm/h with the
// 99th percentile at 7.6, so Heavy sits where genuinely heavy rain sits and
// Severe is reserved for a deluge or for the promotion below.
//
// Those figures are worth keeping in view when adjusting these: bands set above
// the range the source actually produces yield an alert that never fires, which
// is indistinguishable from fair weather and therefore the one failure this
// plugin cannot afford.
function levelForPrecipitation(mmPerSlot) {
  var mmPerHour = ratePerHour(mmPerSlot)
  if (mmPerHour >= RATE_SEVERE) return SEVERE
  if (mmPerHour >= RATE_HEAVY) return HEAVY
  if (mmPerHour >= RATE_MODERATE) return MODERATE
  if (mmPerHour >= RATE_LIGHT) return LIGHT
  return CLEAR
}

// CAPE measures the energy available for convection; gusts measure what the
// atmosphere is already doing with it. Rain alone does not make weather severe
// — rain arriving into an unstable airmass does — so this promotes an
// already-rainy slot one band rather than firing on its own.
//
// Calibrated against forecasts for 268 points across the world's convective
// regions, where gusts reach the 99th percentile at 55 km/h and top out at 63.
// A rule requiring high gusts *alongside* instability therefore asks for a
// value the model barely produces and matches almost nothing, so strong
// instability qualifies on its own at 2000 J/kg, with a second arm for windier
// setups that are less unstable.
var CAPE_UNSTABLE = 2000
var CAPE_MARGINAL = 1000
var GUST_STRONG = 45

function severeConditions(cape, gust) {
  return cape >= CAPE_UNSTABLE || (cape >= CAPE_MARGINAL && gust >= GUST_STRONG)
}

// ---------------------------------------------------------------------------
// Lead time
// ---------------------------------------------------------------------------

// How fast weather is assumed to travel, for turning "watch 100 km out" into
// "look two hours ahead". Storms move at 40-60 km/h across most of the world;
// the midpoint is close enough for a figure that is always stated as "about".
var ASSUMED_STORM_SPEED_KMH = 50

function leadMinutesFor(radiusKm) {
  return Math.round(radiusKm / ASSUMED_STORM_SPEED_KMH * 60)
}

// How many 15-minute slots of forecast to read. Floored at an hour so a small
// radius still looks far enough ahead to be worth a notification, and capped at
// six so a large one does not warn about weather nobody can plan around yet.
function forecastSlotsFor(leadMinutes) {
  return Math.max(4, Math.min(24, Math.ceil(leadMinutes / SLOT_MINUTES)))
}

// What the line under the alert switch says.
//
// A quiet plugin and a broken one look the same unless this distinguishes
// them, and the distinctions are finer than they look: never asked, asking,
// asked and failed, asked and got nothing usable, asked and there is nothing to
// report. Getting this wrong is not a cosmetic fault — it is the plugin
// claiming to be watching when it is not.
//
// A reading already in hand is kept and marked rather than replaced by the
// error. Losing it would trade something true and slightly old for nothing at
// all, and the reading is what somebody opened the panel to see.
//
// `status` carries: alertsEnabled, locationState, checking, everAnswered,
// failing, hasReading, outlookLevel, outlookLabel, outlookAtClock.
function alertStatus(status) {
  if (!status.alertsEnabled) return "off"

  // A name with nothing behind it is not nothing stored, and saying so would
  // send somebody to set a location they have already set.
  if (status.locationState === "unresolved") return "the saved location has no coordinates"
  if (status.locationState !== "ready") return "no location set"

  if (status.checking) return "checking…"

  // Only true before anything has come back. A check that failed also
  // happened, and repeated failure backs the interval off, so claiming to be
  // starting could stand for the best part of an hour.
  if (!status.everAnswered) return "starting…"

  if (!status.hasReading) {
    return status.failing ? "cannot reach the forecast" : "no forecast for this location"
  }

  var reading = status.outlookLevel === 0
    ? "nothing expected"
    : String(status.outlookLabel).toLowerCase() + " expected"
        + (status.outlookAtClock ? " around " + status.outlookAtClock : "")

  return status.failing ? reading + " · not updating" : reading
}

// Whether opening the map should ask for the forecast again.
//
// A run of failures otherwise stands until the next tick, which is ten minutes
// with the map open and longer with it closed, because repeated failure backs
// the interval off. Somebody who has just reconnected and opened the panel is
// asking to try again, and being told the forecast cannot be reached for the
// next quarter of an hour is not an answer to that.
//
// Only when it has been failing: a reading at most one cadence old is what the
// source publishes anyway, so re-fetching it would be load for no information.
//
// The floor is short on purpose. It is there to bound a burst from opening and
// closing repeatedly, not to make somebody wait — reconnecting and reopening
// happens well inside a minute, and a floor long enough to catch that refuses
// the one retry that was actually asked for.
function shouldRetryForecast(request) {
  var since = request.now - request.lastAnswer
  var sinceReading = request.now - request.lastReading

  // A stamp in the future is a clock that moved, not a request from later.
  // Left alone it would refuse every refresh until real time caught up — and
  // both stamps need the guard, since either can be the one that outlives the
  // correction.
  if (!(request.lastAnswer > 0) || since < 0) return true
  if (since < request.floor) return false

  // Failing, or holding a reading older than the source publishes. Anything
  // fresher than that would be a request for bytes already in hand.
  if (request.failing) return true
  if (!(request.lastReading > 0) || sinceReading < 0) return true
  return sinceReading >= request.cadence
}

// ---------------------------------------------------------------------------
// Reducing a forecast
// ---------------------------------------------------------------------------

// Open-Meteo returns local ISO timestamps like "2026-08-15T20:15" because the
// request asks for timezone=auto, so the clock part is already in the user's
// own time and needs no conversion.
function clockFromTimestamp(value) {
  var text = String(value || "")
  var marker = text.indexOf("T")
  if (marker === -1) return ""
  return text.substring(marker + 1, marker + 6)
}

// The hour a timestamp falls in, as a key. "2026-08-30T12:45" and
// "2026-08-30T12:00" both answer "2026-08-30T12", which is what pairs a
// quarter-hour slot with the hourly series it sits inside.
function hourKey(timestamp) {
  var text = String(timestamp || "")
  return text.length >= 13 ? text.substring(0, 13) : ""
}

// Instability per hour, peaked across every sampled point.
//
// Across points, not within them: a town is not a grid cell, and an airmass
// does not stop at the edge of one. Across *hours* would be wrong for the same
// reason it is right across points — the atmosphere at five in the afternoon is
// not the atmosphere now, and pairing the two is how rain falling in stable air
// gets called a storm because a squall is forecast for later.
function hourlyPeaks(entries) {
  var peaks = {}
  for (var e = 0; e < entries.length; e++) {
    var entry = entries[e]
    if (!entry || !entry.hourly || !entry.hourly.time) continue
    var times = entry.hourly.time
    var cape = entry.hourly.cape || []
    var gust = entry.hourly.wind_gusts_10m || []
    for (var h = 0; h < times.length; h++) {
      var key = hourKey(times[h])
      if (!key) continue
      var held = peaks[key] || { cape: 0, gust: 0 }
      peaks[key] = {
        cape: Math.max(held.cape, Number(cape[h]) || 0),
        gust: Math.max(held.gust, Number(gust[h]) || 0)
      }
    }
  }
  return peaks
}

// Reduce one sampled point to the worst thing it forecasts inside the lead
// window. Returns null for a response that carries no usable series.
//
// `peaks` is what hourlyPeaks returned. A slot with no matching hour is judged
// on its rain alone: the hourly series is requested to cover the window, so a
// gap means the response was short, and inventing instability for it would be
// the one direction of error this plugin cannot afford.
function summarizePoint(entry, peaks, slots) {
  if (!entry || !entry.minutely_15) return null

  var precipitation = entry.minutely_15.precipitation || []
  var times = entry.minutely_15.time || []
  peaks = peaks || {}

  var level = CLEAR
  var lead = 0
  var rain = 0
  var clock = ""
  var cape = 0
  var gust = 0

  for (var i = 0; i < precipitation.length && i < slots; i++) {
    var mm = Number(precipitation[i]) || 0
    var slotLevel = levelForPrecipitation(mm)
    if (slotLevel === CLEAR) continue

    // Precipitation into an unstable airmass is what turns a shower into a
    // storm; promote one band when the environment supports it — the
    // environment *this slot* is falling into, not the worst hour anywhere in
    // the window. Taking the window's peak made the alert radius, which is a
    // setting about how far ahead to look, change what the plugin said about
    // rain already falling: at 200 km it reached a 45 km/h gust forecast three
    // hours out and reported moderate rain under way as heavy.
    var hour = peaks[hourKey(times[i])] || { cape: 0, gust: 0 }
    if (slotLevel >= MODERATE && severeConditions(hour.cape, hour.gust)) {
      slotLevel = Math.min(SEVERE, slotLevel + 1)
    }

    if (slotLevel > level) {
      level = slotLevel
      // Index 0 is the 15-minute slot already under way, so it reads as now.
      lead = i * SLOT_MINUTES
      // Taken from the response rather than computed as now-plus-lead, so the
      // stated time is the model's own slot and cannot drift.
      clock = clockFromTimestamp(times[i])
      // Reported alongside the level, so the detail in the toast describes the
      // moment being warned about rather than the worst one in the window.
      // The rain rate is the same question as the instability was: the window
      // peak belongs to whichever slot happens to be wettest, which is not
      // necessarily the slot the verdict came from — a shower promoted to
      // severe by an unstable hour would be announced with a downpour's rate
      // borrowed from three hours later, and severityDetail would print it as
      // part of the reason.
      rain = mm
      cape = hour.cape
      gust = hour.gust
    }
  }

  return { level: level, lead: lead, rain: rain, clock: clock, cape: cape, gust: gust }
}

// Reduce a whole response — one point or several — to a single outlook.
// Returns null when nothing in it is usable, which the caller reads as "keep
// what you had" rather than as "the weather is clear".
function summarizeForecast(data, slots) {
  // One coordinate returns an object, several return an array. Normalising
  // here keeps the rest indifferent to how many were asked for.
  var entries = Array.isArray(data) ? data : [data]
  if (entries.length === 0) return null

  // Instability is a property of the airmass rather than of any one grid cell,
  // so it is peaked across the whole sampled area — but kept per hour, so each
  // slot is judged against the air it is actually falling into.
  var peaks = hourlyPeaks(entries)

  // The worst of the sampled points wins, and among equals the soonest. A town
  // is not a point: reporting the centre alone would stay quiet through a storm
  // sitting over the far side of it.
  var worst = null
  for (var p = 0; p < entries.length; p++) {
    var summary = summarizePoint(entries[p], peaks, slots)
    if (!summary) continue
    if (!worst
        || summary.level > worst.level
        || (summary.level === worst.level && summary.lead < worst.lead)) {
      worst = summary
    }
  }
  if (!worst) return null

  return {
    level: worst.level,
    leadMinutes: worst.lead,
    clock: worst.clock,
    precipitation: worst.rain,
    cape: worst.cape,
    gust: worst.gust
  }
}

// ---------------------------------------------------------------------------
// The notification latch
// ---------------------------------------------------------------------------

// Whether this outlook is worth telling the user about, given what they were
// last told. Returns the decision and the latch value to keep, so the caller
// stores one thing and cannot get the two out of step.
//
// The latch is held until conditions clear so a storm that lingers for three
// hours does not notify eighteen times, while a situation that worsens still
// escalates. It is cleared only once the outlook drops back under the
// threshold, so a reading that flickers around the boundary cannot re-notify.
function decideNotification(outlookLevel, notifiedLevel, thresholdName, alertsEnabled) {
  if (!alertsEnabled) return { notify: false, notifiedLevel: CLEAR }

  if (outlookLevel < levelValue(thresholdName)) return { notify: false, notifiedLevel: CLEAR }
  if (outlookLevel <= notifiedLevel) return { notify: false, notifiedLevel: notifiedLevel }

  return { notify: true, notifiedLevel: outlookLevel }
}

// ---------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------

function humanizeMinutes(minutes) {
  if (minutes < 60) return minutes + " min"
  var hours = Math.floor(minutes / 60)
  var rest = minutes % 60
  if (rest === 0) return hours + "h"
  return hours + "h" + (rest < 10 ? "0" + rest : rest)
}

// The figures behind a severe alert, naming only the ones that put it there.
//
// A severe reading can arrive by two routes — rain heavy enough on its own, or
// ordinary rain into an unstable airmass — and each is evidenced by different
// numbers. Printing all of them regardless produces sentences that argue
// against themselves: "severe storm, gusts to 17 km/h" reads as a
// contradiction, because a gust that mild had nothing to do with the verdict.
// Each figure appears only when it is part of the reason.
function severityDetail(level, precipitationPerSlot, cape, gust) {
  if (level < SEVERE) return ""

  var reasons = []
  var rate = ratePerHour(precipitationPerSlot)
  if (rate >= RATE_SEVERE) reasons.push("up to " + Math.round(rate) + " mm/h")
  if (cape >= CAPE_UNSTABLE) reasons.push("CAPE " + Math.round(cape) + " J/kg")
  if (gust >= GUST_STRONG) reasons.push("gusts to " + Math.round(gust) + " km/h")

  return reasons.length > 0 ? " — " + reasons.join(", ") : ""
}

// A place name with the two characters markup is built from taken out.
//
// The notification body ends with the stored location name, and that name is
// not this plugin's: `weather.json` is shared with the stock weather widget,
// anything on the machine can write it, and the README invites people to hand-
// edit it. The body is rendered by Omarchy's own NotificationCard with
// `Text.StyledText`, which was measured to fetch the source of an `<img>` tag
// — see test/text-format.sh. Every Text this plugin owns declares
// `Text.PlainText` and keeps the name whole; this one cannot, because the
// component belongs to the shell.
//
// So the characters go instead. Nothing opens a tag without `<` and nothing
// opens an entity without `&`, which leaves a string a rich text parser has no
// construct to find, whatever heuristic decides to run it. That is a property
// of the syntax rather than of a Qt version or of a mode somebody may change.
function inertText(value) {
  return String(value == null ? "" : value).replace(/[<&]/g, "")
}

// The headline, the body and the urgency of the toast.
//
// `outlook` is what summarizeForecast returned. Urgency decides how long the
// toast stays: Omarchy gives a critical popup no expiry and caps everything
// else at thirty seconds, so "until dismissed" is only reachable through it.
//
// Heavy and above therefore go out as critical. The value of an alert lies
// entirely in the moment nobody was looking, and a timed toast that fires while
// the desk is empty is a toast that never happened — which is the case the
// alert exists for. Heavy is also the default threshold, the level this plugin
// itself calls worth interrupting someone over, so letting it expire unseen
// would contradict that. The cost is one click.
//
// Critical here does not mean emergency. Omarchy only lets a popup through Do
// Not Disturb when the sender is CLI-style, and this one names itself, so a
// silenced session files these into history instead of showing them.
//
// Moderate and Light stay on the eight-second default. They are worth saying
// and not worth camping on the screen.
function notificationText(outlook, locationName) {
  var level = outlook.level
  var name = levelName(level)

  // Already under way reads differently from on its way. This is the normal
  // case when someone turns alerts on during weather they can already see,
  // where "approaching" would contradict the "starting now" beneath it.
  var underway = outlook.leadMinutes <= 0
  var headline = level >= SEVERE
    ? (underway ? "Severe storm overhead" : "Severe storm approaching")
    : (underway ? name + " rain now" : name + " rain approaching")

  // Both a relative and an absolute time. The relative one is what the eye
  // wants at the moment the toast appears; the absolute one is what saves it
  // from lying to someone who reads it later, or who was away from the desk
  // when it arrived.
  var description = underway ? "under way" : "in about " + humanizeMinutes(outlook.leadMinutes)
  if (outlook.clock) description += underway ? " since " + outlook.clock : ", around " + outlook.clock
  if (locationName) description += " at " + inertText(locationName)
  description += severityDetail(level, outlook.precipitation, outlook.cape, outlook.gust)

  return {
    headline: headline,
    description: description,
    urgency: level >= HEAVY ? "critical" : "normal"
  }
}

// The same interval in the panel's register rather than the toast's. A toast
// is glanced at and wants "1h30"; a line of prose under a control is read and
// wants "1 h 30 min". Both live here so a change to one is made next to the
// other.
function humanizeLead(minutes) {
  if (minutes < 60) return minutes + " min"
  var hours = Math.floor(minutes / 60)
  var rest = minutes % 60
  if (rest === 0) return hours + " h"
  return hours + " h " + rest + " min"
}

// What the chosen band actually means in weather, rather than leaving the user
// to guess where the line between "Moderate" and "Heavy" falls.
function thresholdCaption(name) {
  if (name === "Light") return "anything from drizzle up"
  if (name === "Moderate") return "steady rain and worse"
  if (name === "Severe") return "only severe storms"
  return "downpours and storms"
}
