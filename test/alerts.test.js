const { test } = require("node:test")
const assert = require("node:assert")
const { loadLibrary } = require("./load.js")

const Alerts = loadLibrary("Alerts.js")

// A slot is a quarter hour, so a rate in mm/h divided by four is what the
// forecast series actually carries. Tests are written in mm/h, the unit the
// published scale uses, and converted here.
function slot(mmPerHour) {
  return mmPerHour / 4
}

function forecast(rates, options) {
  const settings = options || {}
  return {
    minutely_15: {
      precipitation: rates.map(slot),
      time: rates.map((_, i) => {
        const minutes = (settings.startMinute || 0) + i * 15
        const hour = 20 + Math.floor(minutes / 60)
        return `2026-08-15T${String(hour).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`
      })
    },
    hourly: hourly(rates.length, settings)
  }
}

// The hourly series the slots above sit inside. One entry per hour they span,
// because the promotion rule pairs a slot with its own hour: a fixture that
// declared a single hour would leave every later slot without one.
//
// `cape` and `gust` set every hour; `capeByHour` and `gustByHour` set them one
// at a time, which is what the tests about *when* the air is unstable need.
function hourly(slotCount, settings) {
  const first = 20 + Math.floor((settings.startMinute || 0) / 60)
  const last = 20 + Math.floor(((settings.startMinute || 0) + (slotCount - 1) * 15) / 60)
  const time = []
  const cape = []
  const gust = []
  for (let hour = first; hour <= last; hour++) {
    const index = hour - first
    time.push(`2026-08-15T${String(hour).padStart(2, "0")}:00`)
    cape.push(settings.capeByHour ? (settings.capeByHour[index] || 0) : (settings.cape || 0))
    gust.push(settings.gustByHour ? (settings.gustByHour[index] || 0) : (settings.gust || 0))
  }
  return { time: time, cape: cape, wind_gusts_10m: gust }
}

// summarizePoint is handed the hourly peaks the whole response produced, so
// tests derive them from the same fixture. Passing numbers alongside the entry
// is what let a test assert instability the entry did not carry.
function point(entry, slots) {
  return Alerts.summarizePoint(entry, Alerts.hourlyPeaks([entry]), slots)
}

// ------------------------------------------------------------------ levels

test("level names and values are inverses of each other", () => {
  for (const name of ["Clear", "Light", "Moderate", "Heavy", "Severe"]) {
    assert.strictEqual(Alerts.levelName(Alerts.levelValue(name)), name)
  }
})

test("an unrecognised threshold reads as clear rather than as severe", () => {
  // A settings file carrying a value from a future version must not silently
  // become the loudest setting.
  for (const name of ["", null, undefined, "nonsense", "SEVERE!"]) {
    assert.strictEqual(Alerts.levelValue(name), Alerts.CLEAR, JSON.stringify(name))
  }
  assert.strictEqual(Alerts.levelValue("SEVERE"), Alerts.SEVERE, "case is not significant")
})

test("every threshold the user can pick is a level the bands can produce", () => {
  for (const name of Alerts.THRESHOLD_OPTIONS) {
    const level = Alerts.levelValue(name)
    assert.ok(level >= Alerts.LIGHT && level <= Alerts.SEVERE, name)
  }
  assert.ok(!Alerts.THRESHOLD_OPTIONS.includes("Clear"),
    "there is no such thing as being notified that nothing is happening")
})

// ------------------------------------------------------------------ bands

test("the precipitation bands sit exactly on the published scale", () => {
  assert.strictEqual(Alerts.levelForPrecipitation(slot(0)), Alerts.CLEAR)
  assert.strictEqual(Alerts.levelForPrecipitation(slot(0.29)), Alerts.CLEAR)
  assert.strictEqual(Alerts.levelForPrecipitation(slot(0.3)), Alerts.LIGHT)
  assert.strictEqual(Alerts.levelForPrecipitation(slot(2.49)), Alerts.LIGHT)
  assert.strictEqual(Alerts.levelForPrecipitation(slot(2.5)), Alerts.MODERATE)
  assert.strictEqual(Alerts.levelForPrecipitation(slot(7.59)), Alerts.MODERATE)
  assert.strictEqual(Alerts.levelForPrecipitation(slot(7.6)), Alerts.HEAVY)
  assert.strictEqual(Alerts.levelForPrecipitation(slot(14.9)), Alerts.HEAVY)
  assert.strictEqual(Alerts.levelForPrecipitation(slot(15)), Alerts.SEVERE)
  assert.strictEqual(Alerts.levelForPrecipitation(slot(100)), Alerts.SEVERE)
})

// The band that has to be checked against the source rather than against the
// scale. Open-Meteo rounds precipitation to a tenth of a millimetre per slot,
// so 0.1 mm is not a small reading — it is the smallest reading that exists,
// and in a sample of 1728 slots it was 59% of every wet one. A lowest band
// above it reports the commonest rain there is as no rain, which is the one
// failure this plugin cannot afford: silence that looks like fair weather.
test("the smallest amount of rain the source can express is not called clear", () => {
  const step = 0.1
  assert.strictEqual(Alerts.levelForPrecipitation(step), Alerts.LIGHT,
    "one reporting step of precipitation must reach the lowest band")

  // And it is the step, not a value chosen here, that the band has to clear.
  assert.ok(Alerts.RATE_LIGHT < Alerts.ratePerHour(step),
    "the lowest band must sit below one reporting step, not on it")

  // Nothing lands between nothing and one step, so the comparison is never
  // made against a value the source can actually produce.
  assert.strictEqual(Alerts.levelForPrecipitation(0), Alerts.CLEAR)
})

test("the bands stay inside the range the forecast source actually produces", () => {
  // The calibration sample — 2144 forecast slots across the Sahel, the Amazon,
  // the United States, Indonesia and India — reached 9.6 mm/h at most, with the
  // 99th percentile at 7.6. A band set above that ceiling yields an alert that
  // can never fire, which is indistinguishable from fair weather and is the one
  // failure this plugin cannot afford.
  const OBSERVED_MAXIMUM = 9.6
  assert.ok(Alerts.RATE_HEAVY <= OBSERVED_MAXIMUM,
    `Heavy at ${Alerts.RATE_HEAVY} mm/h is above anything the model was seen to produce`)
  assert.strictEqual(Alerts.levelForPrecipitation(slot(OBSERVED_MAXIMUM)), Alerts.HEAVY,
    "the wettest slot ever sampled has to reach the default threshold")
})

test("instability promotes rain but never invents it", () => {
  const unstable = [3000, 0]     // CAPE alone is enough
  const windy = [1500, 50]       // marginal CAPE with strong gusts

  for (const [cape, gust] of [unstable, windy]) {
    assert.strictEqual(Alerts.severeConditions(cape, gust), true, `${cape} / ${gust}`)
  }
  // Neither arm on its own is severe weather.
  assert.strictEqual(Alerts.severeConditions(1500, 20), false, "unstable but calm")
  assert.strictEqual(Alerts.severeConditions(500, 80), false, "windy but stable")
  assert.strictEqual(Alerts.severeConditions(0, 0), false)
})

test("a promoted slot is one that was already raining", () => {
  // Moderate into an unstable airmass becomes heavy...
  const promoted = point(forecast([3], { cape: 3000 }), 4)
  assert.strictEqual(promoted.level, Alerts.HEAVY)

  // ...but drizzle stays drizzle, however unstable the air is. Instability is
  // a multiplier on rain, not a source of it.
  const drizzle = point(forecast([1], { cape: 3000 }), 4)
  assert.strictEqual(drizzle.level, Alerts.LIGHT)

  // And a clear slot in an explosive airmass is still a clear slot.
  const dry = point(forecast([0], { cape: 5000 }), 4)
  assert.strictEqual(dry.level, Alerts.CLEAR)
})

// The rule this pins is *when* the air has to be unstable, not whether.
//
// Instability was taken as the peak over the whole forecast window, and the
// window length comes from the alert radius. So a squall forecast for the
// afternoon promoted rain falling now, and widening the radius from 150 km to
// 200 km changed "Moderate rain now" into "Heavy rain now" — a setting about
// how far ahead to look, rewriting what the plugin said about the present.
test("a slot is promoted by its own hour, not by a later one", () => {
  // Moderate rain in the first hour; the instability arrives in the second.
  const later = forecast([3, 0, 0, 0, 0, 0, 0, 0], { capeByHour: [0, 3000] })
  const summary = point(later, 8)

  assert.strictEqual(summary.level, Alerts.MODERATE,
    "rain falling into stable air is not a storm because one is forecast later")
  assert.strictEqual(summary.lead, 0)
})

test("and is promoted when the instability is in its own hour", () => {
  // The same instability, with the rain moved into the hour that carries it.
  const together = forecast([0, 0, 0, 0, 3, 0, 0, 0], { capeByHour: [0, 3000] })
  const summary = point(together, 8)

  assert.strictEqual(summary.level, Alerts.HEAVY)
  assert.strictEqual(summary.lead, 60, "the hour it was promoted in is the hour it is reported for")
})

test("the reported instability is the promoted hour's, not the window's", () => {
  const entry = forecast([0, 0, 0, 0, 3, 0, 0, 0], { capeByHour: [9000, 3000] })
  const outlook = Alerts.summarizeForecast([entry], 8)

  assert.strictEqual(outlook.cape, 3000,
    "the toast describes the hour being warned about")
})

// The symptom, stated as the invariant it broke: looking further ahead may
// find worse weather later, but it cannot change the verdict on the slot
// already under way.
test("widening the window does not change what is said about the present", () => {
  const entry = forecast([3, 0, 0, 0, 0, 0, 0, 0], { capeByHour: [0, 3000] })

  const near = Alerts.summarizeForecast([entry], 4)
  const far = Alerts.summarizeForecast([entry], 8)

  assert.strictEqual(near.level, Alerts.MODERATE)
  assert.strictEqual(far.level, Alerts.MODERATE)
  assert.strictEqual(near.leadMinutes, far.leadMinutes)
})

test("a slot with no hour of its own is judged on its rain alone", () => {
  // A response whose hourly series stops short. Inventing instability for the
  // uncovered slots is the one direction of error this cannot afford.
  const entry = forecast([3, 0, 0, 0, 0, 0, 0, 0], { cape: 3000 })
  entry.hourly.time = entry.hourly.time.slice(0, 1)
  entry.hourly.cape = entry.hourly.cape.slice(0, 1)
  entry.hourly.wind_gusts_10m = entry.hourly.wind_gusts_10m.slice(0, 1)

  const uncovered = forecast([0, 0, 0, 0, 3, 0, 0, 0], { cape: 3000 })
  uncovered.hourly.time = uncovered.hourly.time.slice(0, 1)
  uncovered.hourly.cape = uncovered.hourly.cape.slice(0, 1)
  uncovered.hourly.wind_gusts_10m = uncovered.hourly.wind_gusts_10m.slice(0, 1)

  assert.strictEqual(point(entry, 8).level, Alerts.HEAVY, "the covered hour still promotes")
  assert.strictEqual(point(uncovered, 8).level, Alerts.MODERATE, "the uncovered one does not")
})

test("hourlyPeaks takes the highest across points, hour by hour", () => {
  const calm = forecast([0, 0, 0, 0, 0, 0, 0, 0], { capeByHour: [100, 200] })
  const rough = forecast([0, 0, 0, 0, 0, 0, 0, 0], { capeByHour: [50, 4000] })
  const peaks = Alerts.hourlyPeaks([calm, rough])

  assert.strictEqual(peaks["2026-08-15T20"].cape, 100)
  assert.strictEqual(peaks["2026-08-15T21"].cape, 4000,
    "a town is not a point, so the worst of the sampled cells wins")
})

test("promotion cannot push a level past severe", () => {
  const summary = point(forecast([30], { cape: 4000 }), 4)
  assert.strictEqual(summary.level, Alerts.SEVERE)
})

// ------------------------------------------------------------------ lead time

test("lead time follows the radius at the assumed storm speed", () => {
  assert.strictEqual(Alerts.leadMinutesFor(50), 60)
  assert.strictEqual(Alerts.leadMinutesFor(100), 120, "the default radius is about two hours out")
  assert.strictEqual(Alerts.leadMinutesFor(250), 300)
})

test("the forecast window is bounded at both ends", () => {
  // A small radius still looks an hour ahead, so the alert has something to
  // say; a large one stops short of weather nobody can plan around yet.
  assert.strictEqual(Alerts.forecastSlotsFor(15), 4)
  assert.strictEqual(Alerts.forecastSlotsFor(0), 4)
  assert.strictEqual(Alerts.forecastSlotsFor(120), 8)
  assert.strictEqual(Alerts.forecastSlotsFor(600), 24)
})

// ------------------------------------------------------------------ reduction

test("the worst slot inside the window is the one reported", () => {
  const summary = point(forecast([0, 1, 9, 3]), 4)
  assert.strictEqual(summary.level, Alerts.HEAVY)
  assert.strictEqual(summary.leadMinutes, undefined, "summarizePoint reports `lead`")
  assert.strictEqual(summary.lead, 30, "the third slot is half an hour out")
  assert.strictEqual(summary.clock, "20:30", "the clock comes from the model's own slot")
})

test("weather beyond the window is not reported", () => {
  // A downpour in six hours is not an alert; it is a forecast.
  const summary = point(forecast([0, 0, 0, 0, 20]), 4)
  assert.strictEqual(summary.level, Alerts.CLEAR)
})

test("the first slot reads as now, not as fifteen minutes away", () => {
  const summary = point(forecast([9]), 4)
  assert.strictEqual(summary.lead, 0)
})

test("a response with no usable series is null, not clear", () => {
  // Null means "keep what you had". Clear means "it is not going to rain", and
  // saying that on the strength of a broken response is the failure mode this
  // plugin most has to avoid.
  assert.strictEqual(point(null, 4), null)
  assert.strictEqual(point({}, 4), null)
  assert.strictEqual(Alerts.summarizeForecast([], 4), null)
  assert.strictEqual(Alerts.summarizeForecast([null, {}], 4), null)
})

test("a missing precipitation series is not an empty one", () => {
  const summary = point({ minutely_15: { time: [] } }, 4)
  assert.strictEqual(summary.level, Alerts.CLEAR)
  assert.strictEqual(summary.clock, "")
})

test("instability is taken across the whole sampled area", () => {
  // CAPE is a property of the airmass, not of a grid cell. A neighbouring
  // sample carrying the instability has to promote the rainy one.
  const rainy = forecast([3], { cape: 0 })
  const unstable = forecast([0], { cape: 3000 })
  const outlook = Alerts.summarizeForecast([rainy, unstable], 4)
  assert.strictEqual(outlook.level, Alerts.HEAVY, "moderate rain promoted by the neighbour's CAPE")
  assert.strictEqual(outlook.cape, 3000)
})

test("the worst sampled point wins, and among equals the soonest", () => {
  const later = forecast([0, 0, 9])
  const sooner = forecast([9])
  const outlook = Alerts.summarizeForecast([later, sooner], 4)
  assert.strictEqual(outlook.level, Alerts.HEAVY)
  assert.strictEqual(outlook.leadMinutes, 0, "the same severity arriving sooner is the one to report")

  const worse = forecast([0, 0, 20])
  const mild = forecast([1])
  assert.strictEqual(Alerts.summarizeForecast([mild, worse], 4).level, Alerts.SEVERE,
    "severity outranks proximity")
})

test("a single point may arrive as an object rather than an array", () => {
  const outlook = Alerts.summarizeForecast(forecast([9]), 4)
  assert.strictEqual(outlook.level, Alerts.HEAVY)
})

test("the reported peak is the wettest slot anywhere in the sample", () => {
  const outlook = Alerts.summarizeForecast([forecast([1]), forecast([12])], 4)
  assert.ok(Math.abs(Alerts.ratePerHour(outlook.precipitation) - 12) < 1e-9)
})

test("a garbled number in the series is read as no rain, not as NaN", () => {
  const entry = { minutely_15: { precipitation: [null, "abc", undefined, slot(9)], time: [] } }
  const summary = point(entry, 4)
  assert.ok(Number.isFinite(summary.peak))
  assert.strictEqual(summary.level, Alerts.HEAVY, "the one real value still counts")
  assert.strictEqual(summary.lead, 45, "and it is placed in its own slot")
})

// ------------------------------------------------------------------ the latch

test("an alert fires once and then holds", () => {
  let latch = Alerts.CLEAR
  let decision = Alerts.decideNotification(Alerts.HEAVY, latch, "Heavy", true)
  assert.strictEqual(decision.notify, true)
  latch = decision.notifiedLevel

  // The same storm, still forecast, ten minutes later.
  decision = Alerts.decideNotification(Alerts.HEAVY, latch, "Heavy", true)
  assert.strictEqual(decision.notify, false, "a storm that lingers must not notify eighteen times")
  assert.strictEqual(decision.notifiedLevel, Alerts.HEAVY, "the latch is kept")
})

test("a situation that worsens still escalates", () => {
  const decision = Alerts.decideNotification(Alerts.SEVERE, Alerts.HEAVY, "Heavy", true)
  assert.strictEqual(decision.notify, true)
  assert.strictEqual(decision.notifiedLevel, Alerts.SEVERE)
})

test("the latch clears only once conditions drop under the threshold", () => {
  // Heavy threshold, outlook falls to moderate: below the threshold, so the
  // latch resets and the next heavy reading notifies again.
  const cleared = Alerts.decideNotification(Alerts.MODERATE, Alerts.HEAVY, "Heavy", true)
  assert.strictEqual(cleared.notify, false)
  assert.strictEqual(cleared.notifiedLevel, Alerts.CLEAR)

  assert.strictEqual(Alerts.decideNotification(Alerts.HEAVY, cleared.notifiedLevel, "Heavy", true).notify, true)
})

test("weather under the threshold is never announced", () => {
  for (const [outlook, threshold] of [[Alerts.LIGHT, "Moderate"], [Alerts.MODERATE, "Heavy"],
                                      [Alerts.HEAVY, "Severe"], [Alerts.CLEAR, "Light"]]) {
    assert.strictEqual(Alerts.decideNotification(outlook, Alerts.CLEAR, threshold, true).notify, false,
      `${Alerts.levelName(outlook)} against a ${threshold} threshold`)
  }
})

test("turning alerts off clears the latch as well as silencing it", () => {
  // Otherwise turning them back on during the same storm would stay silent,
  // because the latch would still be holding a level nobody was told about.
  const decision = Alerts.decideNotification(Alerts.SEVERE, Alerts.HEAVY, "Heavy", false)
  assert.strictEqual(decision.notify, false)
  assert.strictEqual(decision.notifiedLevel, Alerts.CLEAR)
})

// ------------------------------------------------------------------ wording

test("elapsed time is written the way a person would say it", () => {
  assert.strictEqual(Alerts.humanizeMinutes(0), "0 min")
  assert.strictEqual(Alerts.humanizeMinutes(45), "45 min")
  assert.strictEqual(Alerts.humanizeMinutes(60), "1h")
  assert.strictEqual(Alerts.humanizeMinutes(90), "1h30")
  assert.strictEqual(Alerts.humanizeMinutes(125), "2h05", "minutes under ten are padded")
  assert.strictEqual(Alerts.humanizeMinutes(120), "2h")
})

test("a timestamp yields the local clock and nothing else", () => {
  assert.strictEqual(Alerts.clockFromTimestamp("2026-08-15T20:15"), "20:15")
  assert.strictEqual(Alerts.clockFromTimestamp("2026-08-15T20:15:00"), "20:15")
  assert.strictEqual(Alerts.clockFromTimestamp("nonsense"), "")
  assert.strictEqual(Alerts.clockFromTimestamp(null), "")
})

test("weather already under way is not described as approaching", () => {
  const now = Alerts.notificationText(
    { level: Alerts.HEAVY, leadMinutes: 0, clock: "20:15", precipitation: slot(9), cape: 0, gust: 0 },
    "Detroit")
  assert.strictEqual(now.headline, "Heavy rain now")
  assert.ok(now.description.startsWith("under way since 20:15"), now.description)

  const soon = Alerts.notificationText(
    { level: Alerts.HEAVY, leadMinutes: 90, clock: "21:45", precipitation: slot(9), cape: 0, gust: 0 },
    "Detroit")
  assert.strictEqual(soon.headline, "Heavy rain approaching")
  assert.ok(soon.description.startsWith("in about 1h30, around 21:45"), soon.description)
})

test("a severe alert names a storm rather than rain", () => {
  const overhead = Alerts.notificationText(
    { level: Alerts.SEVERE, leadMinutes: 0, clock: "", precipitation: slot(20), cape: 0, gust: 0 }, "")
  assert.strictEqual(overhead.headline, "Severe storm overhead")

  const coming = Alerts.notificationText(
    { level: Alerts.SEVERE, leadMinutes: 60, clock: "", precipitation: slot(20), cape: 0, gust: 0 }, "")
  assert.strictEqual(coming.headline, "Severe storm approaching")
})

test("a severe alert cites only the figures that made it severe", () => {
  // "severe storm, gusts to 17 km/h" reads as an argument against itself.
  const byRain = Alerts.severityDetail(Alerts.SEVERE, slot(20), 100, 17)
  assert.ok(byRain.includes("20 mm/h"), byRain)
  assert.ok(!byRain.includes("gusts"), byRain)
  assert.ok(!byRain.includes("CAPE"), byRain)

  const byInstability = Alerts.severityDetail(Alerts.SEVERE, slot(3), 2600, 20)
  assert.ok(byInstability.includes("CAPE 2600 J/kg"), byInstability)
  assert.ok(!byInstability.includes("mm/h"), byInstability)

  const byWind = Alerts.severityDetail(Alerts.SEVERE, slot(3), 1200, 55)
  assert.ok(byWind.includes("gusts to 55 km/h"), byWind)
})

test("only a severe alert carries figures at all", () => {
  for (const level of [Alerts.CLEAR, Alerts.LIGHT, Alerts.MODERATE, Alerts.HEAVY]) {
    assert.strictEqual(Alerts.severityDetail(level, slot(20), 3000, 60), "", Alerts.levelName(level))
  }
})

// The place name is the one string in the notification this plugin did not
// write, and the body is rendered by a component it does not own. See
// test/text-format.sh, which measures that Text.StyledText — the mode
// Omarchy's NotificationCard uses — fetches the source of an img tag.
test("a place name cannot carry markup into the notification body", () => {
  const hostile = 'Springfield<img src="http://127.0.0.1:1/beacon.png">'
  const text = Alerts.notificationText(
    { level: Alerts.MODERATE, leadMinutes: 30, clock: "10:15", precipitation: slot(3), cape: 0, gust: 0 },
    hostile)

  assert.ok(!text.description.includes("<"), text.description)
  assert.ok(!text.description.includes("&"), text.description)

  // The name still reads as the place. Stripping is not redaction: somebody
  // woken at three in the morning has to recognise where the weather is.
  assert.ok(text.description.includes("Springfield"), text.description)
})

test("inertText removes only what opens markup", () => {
  assert.strictEqual(Alerts.inertText("<b>"), "b>")
  assert.strictEqual(Alerts.inertText("&amp;"), "amp;")
  assert.strictEqual(Alerts.inertText("São Paulo"), "São Paulo",
    "an ordinary name passes through whole")
  assert.strictEqual(Alerts.inertText("Stratford-upon-Avon"), "Stratford-upon-Avon")
  assert.strictEqual(Alerts.inertText(null), "")
  assert.strictEqual(Alerts.inertText(undefined), "")
})

test("the location is named when there is one and skipped when there is not", () => {
  const named = Alerts.notificationText(
    { level: Alerts.MODERATE, leadMinutes: 30, clock: "", precipitation: slot(3), cape: 0, gust: 0 },
    "Detroit")
  assert.ok(named.description.endsWith("at Detroit"), named.description)

  const anonymous = Alerts.notificationText(
    { level: Alerts.MODERATE, leadMinutes: 30, clock: "", precipitation: slot(3), cape: 0, gust: 0 }, "")
  assert.ok(!anonymous.description.includes(" at "), anonymous.description)
})

test("an alert worth interrupting someone over does not expire unseen", () => {
  // The value of an alert lies entirely in the moment nobody was looking.
  const urgency = level => Alerts.notificationText(
    { level: level, leadMinutes: 30, clock: "", precipitation: 0, cape: 0, gust: 0 }, "").urgency

  assert.strictEqual(urgency(Alerts.LIGHT), "normal")
  assert.strictEqual(urgency(Alerts.MODERATE), "normal")
  assert.strictEqual(urgency(Alerts.HEAVY), "critical", "Heavy is the default threshold")
  assert.strictEqual(urgency(Alerts.SEVERE), "critical")
})

// ------------------------------------------------------------------ refreshing

const CADENCE = 600000   // the source publishes every ten minutes
const FLOOR = 10000
const NOW = 1788000000000

function request(overrides) {
  return Object.assign({
    now: NOW, lastAnswer: NOW - 30000, lastReading: NOW - 30000,
    failing: false, floor: FLOOR, cadence: CADENCE
  }, overrides)
}

test("opening the map refreshes a forecast that has been failing", () => {
  assert.strictEqual(Alerts.shouldRetryForecast(request({ failing: true })), true)
  assert.strictEqual(Alerts.shouldRetryForecast(request({ lastAnswer: 0, lastReading: 0 })), true,
    "nothing has ever come back")
})

test("a reading younger than the source's own cadence is left alone", () => {
  // Asking again inside the publish cycle is a request for bytes already held.
  assert.strictEqual(Alerts.shouldRetryForecast(request()), false)
})

test("a reading older than the cadence is refreshed when the map opens", () => {
  const stale = NOW - CADENCE - 1
  assert.strictEqual(
    Alerts.shouldRetryForecast(request({ lastAnswer: stale, lastReading: stale })), true)
})

test("repeated opening cannot turn into a request each time", () => {
  assert.strictEqual(
    Alerts.shouldRetryForecast(request({ failing: true, lastAnswer: NOW - 500 })), false)
  assert.strictEqual(
    Alerts.shouldRetryForecast(request({ failing: true, lastAnswer: NOW - FLOOR })), true,
    "the floor is inclusive, so a retry is never one millisecond away forever")
})

test("reconnecting and reopening within a minute still refreshes", () => {
  // Measured against a service driven offline and back: a minute-long floor
  // swallowed the one retry that was actually asked for.
  assert.strictEqual(
    Alerts.shouldRetryForecast(request({ failing: true, lastAnswer: NOW - 15000 })), true)
})

test("a clock that jumped is a reason to refresh, not to wait", () => {
  // An answer stamped in the future would otherwise refuse every refresh until
  // real time caught up — hours, on a machine whose clock was wrong.
  for (const failing of [true, false]) {
    assert.strictEqual(
      Alerts.shouldRetryForecast(request({ lastAnswer: NOW + 3600000, failing: failing })), true)
  }
})

// ------------------------------------------------------------------ the caption

function status(overrides) {
  return Alerts.alertStatus(Object.assign({
    alertsEnabled: true, locationState: "ready", checking: false, everAnswered: true,
    failing: false, hasReading: true, outlookLevel: 0, outlookLabel: "Clear", outlookAtClock: ""
  }, overrides))
}

test("the caption tells a quiet plugin apart from a broken one", () => {
  assert.strictEqual(status({ alertsEnabled: false }), "off")
  assert.strictEqual(status({ locationState: "unresolved" }), "the saved location has no coordinates")
  assert.strictEqual(status({ locationState: "unset" }), "no location set")
  assert.strictEqual(status({ checking: true }), "checking…")
  assert.strictEqual(status({ everAnswered: false }), "starting…")
  assert.strictEqual(status({ hasReading: false, failing: true }), "cannot reach the forecast")
  assert.strictEqual(status({ hasReading: false }), "no forecast for this location")
  assert.strictEqual(status({}), "nothing expected")
  assert.strictEqual(status({ outlookLevel: 3, outlookLabel: "Heavy", outlookAtClock: "21:45" }),
    "heavy expected around 21:45")
})

test("a reading in hand survives the checks behind it failing", () => {
  // Replacing it with the error would trade something true and slightly old for
  // nothing at all, and the reading is what somebody opened the panel to see.
  assert.strictEqual(status({ failing: true }), "nothing expected · not updating")
  assert.strictEqual(
    status({ failing: true, outlookLevel: 3, outlookLabel: "Heavy", outlookAtClock: "21:45" }),
    "heavy expected around 21:45 · not updating")
})

test("no two states of the watch say the same thing", () => {
  const seen = new Set()
  for (const overrides of [{ alertsEnabled: false }, { locationState: "unresolved" },
                           { locationState: "unset" }, { checking: true },
                           { everAnswered: false }, { hasReading: false, failing: true },
                           { hasReading: false }, {}, { failing: true }]) {
    const line = status(overrides)
    assert.ok(line.length > 0, JSON.stringify(overrides))
    assert.ok(!seen.has(line), `two states both say "${line}"`)
    seen.add(line)
  }
})

test("a switch that is off says so before anything else", () => {
  // Whatever else is broken, the honest answer to "what is the watch doing" is
  // "nothing, you turned it off".
  assert.strictEqual(status({ alertsEnabled: false, locationState: "unset", failing: true }), "off")
})

test("a clock that jumped backwards after a reading still refreshes", () => {
  // The guard covers both stamps. Either can be the one that outlives an NTP
  // correction, and a reading stamped in the future would otherwise hold the
  // map on it until real time caught up.
  assert.strictEqual(Alerts.shouldRetryForecast(
    request({ lastReading: NOW + 3600000 })), true)
  assert.strictEqual(Alerts.shouldRetryForecast(
    request({ lastAnswer: NOW - 20000, lastReading: NOW + 3600000 })), true)
})
