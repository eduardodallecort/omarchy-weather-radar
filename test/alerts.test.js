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
    hourly: {
      cape: settings.cape === undefined ? [0] : [settings.cape],
      wind_gusts_10m: settings.gust === undefined ? [0] : [settings.gust]
    }
  }
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
  assert.strictEqual(Alerts.levelForPrecipitation(slot(0.49)), Alerts.CLEAR)
  assert.strictEqual(Alerts.levelForPrecipitation(slot(0.5)), Alerts.LIGHT)
  assert.strictEqual(Alerts.levelForPrecipitation(slot(2.49)), Alerts.LIGHT)
  assert.strictEqual(Alerts.levelForPrecipitation(slot(2.5)), Alerts.MODERATE)
  assert.strictEqual(Alerts.levelForPrecipitation(slot(7.59)), Alerts.MODERATE)
  assert.strictEqual(Alerts.levelForPrecipitation(slot(7.6)), Alerts.HEAVY)
  assert.strictEqual(Alerts.levelForPrecipitation(slot(14.9)), Alerts.HEAVY)
  assert.strictEqual(Alerts.levelForPrecipitation(slot(15)), Alerts.SEVERE)
  assert.strictEqual(Alerts.levelForPrecipitation(slot(100)), Alerts.SEVERE)
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
  const promoted = Alerts.summarizePoint(forecast([3], { cape: 3000 }), 3000, 0, 4)
  assert.strictEqual(promoted.level, Alerts.HEAVY)

  // ...but drizzle stays drizzle, however unstable the air is. Instability is
  // a multiplier on rain, not a source of it.
  const drizzle = Alerts.summarizePoint(forecast([1], { cape: 3000 }), 3000, 0, 4)
  assert.strictEqual(drizzle.level, Alerts.LIGHT)

  // And a clear slot in an explosive airmass is still a clear slot.
  const dry = Alerts.summarizePoint(forecast([0], { cape: 5000 }), 5000, 90, 4)
  assert.strictEqual(dry.level, Alerts.CLEAR)
})

test("promotion cannot push a level past severe", () => {
  const summary = Alerts.summarizePoint(forecast([30], { cape: 4000 }), 4000, 0, 4)
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
  const summary = Alerts.summarizePoint(forecast([0, 1, 9, 3]), 0, 0, 4)
  assert.strictEqual(summary.level, Alerts.HEAVY)
  assert.strictEqual(summary.leadMinutes, undefined, "summarizePoint reports `lead`")
  assert.strictEqual(summary.lead, 30, "the third slot is half an hour out")
  assert.strictEqual(summary.clock, "20:30", "the clock comes from the model's own slot")
})

test("weather beyond the window is not reported", () => {
  // A downpour in six hours is not an alert; it is a forecast.
  const summary = Alerts.summarizePoint(forecast([0, 0, 0, 0, 20]), 0, 0, 4)
  assert.strictEqual(summary.level, Alerts.CLEAR)
})

test("the first slot reads as now, not as fifteen minutes away", () => {
  const summary = Alerts.summarizePoint(forecast([9]), 0, 0, 4)
  assert.strictEqual(summary.lead, 0)
})

test("a response with no usable series is null, not clear", () => {
  // Null means "keep what you had". Clear means "it is not going to rain", and
  // saying that on the strength of a broken response is the failure mode this
  // plugin most has to avoid.
  assert.strictEqual(Alerts.summarizePoint(null, 0, 0, 4), null)
  assert.strictEqual(Alerts.summarizePoint({}, 0, 0, 4), null)
  assert.strictEqual(Alerts.summarizeForecast([], 4), null)
  assert.strictEqual(Alerts.summarizeForecast([null, {}], 4), null)
})

test("a missing precipitation series is not an empty one", () => {
  const summary = Alerts.summarizePoint({ minutely_15: { time: [] } }, 0, 0, 4)
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
  const summary = Alerts.summarizePoint(entry, 0, 0, 4)
  assert.ok(Number.isFinite(summary.peak))
  assert.strictEqual(summary.level, Alerts.HEAVY, "the one real value still counts")
  assert.strictEqual(summary.lead, 45, "and it is placed in its own slot")
})

test("peakOf survives a series that is not one", () => {
  assert.strictEqual(Alerts.peakOf(null), 0)
  assert.strictEqual(Alerts.peakOf([]), 0)
  assert.strictEqual(Alerts.peakOf([1, "x", null, 5]), 5)
  assert.strictEqual(Alerts.peakOf([-3, -1]), 0, "a negative reading is not a peak")
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
    "Marmeleiro")
  assert.strictEqual(now.headline, "Heavy rain now")
  assert.ok(now.description.startsWith("under way since 20:15"), now.description)

  const soon = Alerts.notificationText(
    { level: Alerts.HEAVY, leadMinutes: 90, clock: "21:45", precipitation: slot(9), cape: 0, gust: 0 },
    "Marmeleiro")
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

test("the location is named when there is one and skipped when there is not", () => {
  const named = Alerts.notificationText(
    { level: Alerts.MODERATE, leadMinutes: 30, clock: "", precipitation: slot(3), cape: 0, gust: 0 },
    "Marmeleiro")
  assert.ok(named.description.endsWith("at Marmeleiro"), named.description)

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
