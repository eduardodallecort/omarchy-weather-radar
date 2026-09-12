const { test } = require("node:test")
const assert = require("node:assert")
const { loadLibrary } = require("./load.js")

const Alerts = loadLibrary("Alerts.js")

const HERE = "51.5074,-0.1278|London"
const THERE = "33.88,-84.36|Atlanta 30342"
const NOW = 1788735085295

// --- what gets written down --------------------------------------------------

test("an announced level is recorded against the place and the moment", () => {
  assert.deepStrictEqual(Alerts.latchRecord(Alerts.SEVERE, HERE, NOW),
    { location: HERE, level: Alerts.SEVERE, at: NOW })
})

test("a cleared latch is an absent record, not a record of nothing", () => {
  // Stored as {level: 0} it would read back as a real record and be weighed
  // against the place and the clock rather than simply ignored.
  assert.strictEqual(Alerts.latchRecord(0, HERE, NOW), null)
  assert.strictEqual(Alerts.latchRecord(Alerts.CLEAR, HERE, NOW), null)
})

// --- what gets taken back up -------------------------------------------------

test("a fresh record for this place is adopted, so a rebuild stays quiet", () => {
  const record = Alerts.latchRecord(Alerts.SEVERE, HERE, NOW)
  assert.strictEqual(Alerts.adoptedLevel(record, HERE, NOW + 60000), Alerts.SEVERE)
})

test("a record from somewhere else cannot mute this place", () => {
  const record = Alerts.latchRecord(Alerts.SEVERE, THERE, NOW)
  assert.strictEqual(Alerts.adoptedLevel(record, HERE, NOW + 60000), 0)
})

test("a record older than the window belongs to different weather", () => {
  const record = Alerts.latchRecord(Alerts.SEVERE, HERE, NOW)
  const justInside = NOW + Alerts.LATCH_MAX_AGE_MS - 1000
  const justOutside = NOW + Alerts.LATCH_MAX_AGE_MS
  assert.strictEqual(Alerts.adoptedLevel(record, HERE, justInside), Alerts.SEVERE)
  assert.strictEqual(Alerts.adoptedLevel(record, HERE, justOutside), 0)
})

test("a stamp in the future is a clock that moved, not a record from later", () => {
  const record = Alerts.latchRecord(Alerts.SEVERE, HERE, NOW)
  assert.strictEqual(Alerts.adoptedLevel(record, HERE, NOW - 60000), 0)
})

test("nothing readable is adopted as nothing announced", () => {
  for (const bad of [null, undefined, 0, "", "severe", [], { level: 4 }, { location: HERE }]) {
    assert.strictEqual(Alerts.adoptedLevel(bad, HERE, NOW), 0, JSON.stringify(bad) || String(bad))
  }
})

test("a place we cannot name adopts nothing", () => {
  const record = Alerts.latchRecord(Alerts.SEVERE, HERE, NOW)
  assert.strictEqual(Alerts.adoptedLevel(record, "", NOW), 0)
})

// --- how it meets the latch it feeds ----------------------------------------

test("an adopted latch suppresses the repeat the rebuild would have sent", () => {
  // The observed failure: severe already announced, service rebuilt, same
  // severe reading arrives again.
  const record = Alerts.latchRecord(Alerts.SEVERE, HERE, NOW)
  const adopted = Alerts.adoptedLevel(record, HERE, NOW + 5000)
  const decision = Alerts.decideNotification(Alerts.SEVERE, adopted, "Heavy", true)
  assert.strictEqual(decision.notify, false)
})

test("without the stored latch the same rebuild notifies again", () => {
  // The bug this exists to close, pinned so it cannot come back quietly.
  const decision = Alerts.decideNotification(Alerts.SEVERE, 0, "Heavy", true)
  assert.strictEqual(decision.notify, true)
})

test("worsening weather still escalates past an adopted latch", () => {
  const record = Alerts.latchRecord(Alerts.HEAVY, HERE, NOW)
  const adopted = Alerts.adoptedLevel(record, HERE, NOW + 5000)
  const decision = Alerts.decideNotification(Alerts.SEVERE, adopted, "Heavy", true)
  assert.strictEqual(decision.notify, true)
  assert.strictEqual(decision.notifiedLevel, Alerts.SEVERE)
})

test("a level off disk that is not a band is rejected, not clamped", () => {
  // The record is a file: anything on the machine can write it and it outlives
  // a reboot, so it is untrusted input. Rejecting means "you have told them
  // nothing" — one possible duplicate. Clamping an out-of-range level down to
  // SEVERE would adopt a latch nobody set, and silence is the worse direction.
  const at = level => Alerts.adoptedLevel(
    { location: HERE, level: level, at: NOW }, HERE, NOW + 1000, Alerts.LATCH_MAX_AGE_MS)
  for (const junk of [99, Infinity, -5, NaN, 0, "banana", null, undefined, {}]) {
    assert.strictEqual(at(junk), Alerts.CLEAR, String(junk))
  }
  // Real bands still adopt, including the string and fractional forms JSON can carry.
  assert.strictEqual(at(Alerts.SEVERE), Alerts.SEVERE)
  assert.strictEqual(at("3"), Alerts.HEAVY)
  assert.strictEqual(at(2.6), Alerts.HEAVY)
})

test("a rejected latch cannot silence the storm it claimed to cover", () => {
  // The failure mode: a latch pinned above every band, so nothing re-notifies.
  const adopted = Alerts.adoptedLevel(
    { location: HERE, level: 99, at: NOW }, HERE, NOW + 1000, Alerts.LATCH_MAX_AGE_MS)
  assert.strictEqual(adopted, Alerts.CLEAR)
  assert.strictEqual(
    Alerts.decideNotification(Alerts.SEVERE, adopted, "Heavy", true).notify, true)
})

// --- the record is bounded by construction ------------------------------------

test("a runaway location name cannot grow the record it is written into", () => {
  // `name` comes off a file shared with the stock weather widget, read there as
  // String(data.name || "") with no cap. Without a bound here a long one is
  // rewritten into the latch on every escalation.
  const huge = "51.5,-0.1|" + "x".repeat(50000)
  const record = Alerts.latchRecord(Alerts.SEVERE, huge, NOW)
  assert.ok(record.location.length <= 160, "record location must be capped")
  assert.ok(JSON.stringify(record).length < 300, "the whole record stays small")
})

test("a capped key still matches the place it was written for", () => {
  // Capping on write while comparing uncapped would orphan the record — the
  // latch failing open, which is the direction this file exists to avoid.
  const huge = "51.5,-0.1|" + "x".repeat(50000)
  const record = Alerts.latchRecord(Alerts.SEVERE, huge, NOW)
  assert.strictEqual(Alerts.adoptedLevel(record, huge, NOW, Alerts.LATCH_MAX_AGE_MS), Alerts.SEVERE)
})

test("a record written before the cap existed is still adopted", () => {
  // Records already on disk carry the full name; they must not be silently
  // dropped by a cap introduced after they were written.
  const huge = "51.5,-0.1|" + "x".repeat(50000)
  const legacy = { location: huge, level: Alerts.SEVERE, at: NOW }
  assert.strictEqual(Alerts.adoptedLevel(legacy, huge, NOW, Alerts.LATCH_MAX_AGE_MS), Alerts.SEVERE)
})

test("two different places that share a capped prefix are still different places", () => {
  const a = "51.5,-0.1|" + "x".repeat(50000) + "A"
  const b = "52.9,-1.4|" + "x".repeat(50000) + "B"
  const record = Alerts.latchRecord(Alerts.SEVERE, a, NOW)
  assert.strictEqual(Alerts.adoptedLevel(record, b, NOW, Alerts.LATCH_MAX_AGE_MS), 0)
})
