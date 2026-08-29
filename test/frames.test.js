const { test } = require("node:test")
const assert = require("node:assert")
const { loadLibrary } = require("./load.js")

const Frames = loadLibrary("Frames.js")

// RainViewer publishes a frame every ten minutes and keeps about two hours of
// them, so a list is thirteen frames ending at the present.
function listEndingAt(end, count) {
  const frames = []
  for (let i = count - 1; i >= 0; i--) frames.push({ time: end - i * 600, path: "/v2/radar/" + (end - i * 600) })
  return frames
}

const NOON = 1788000000
const FIRST = listEndingAt(NOON, 13)

// ------------------------------------------------------------------ nearest

test("the nearest frame to a moment is the one closest in time", () => {
  assert.strictEqual(Frames.indexNearest(FIRST, NOON), 12)
  assert.strictEqual(Frames.indexNearest(FIRST, NOON - 600), 11)
  assert.strictEqual(Frames.indexNearest(FIRST, NOON - 12 * 600), 0)
  // Between two frames, whichever is closer.
  assert.strictEqual(Frames.indexNearest(FIRST, NOON - 250), 12)
  assert.strictEqual(Frames.indexNearest(FIRST, NOON - 350), 11)
})

test("a moment outside the published window falls on the nearest edge", () => {
  // What somebody scrubbed back to may have aged out entirely. The closest
  // frame still answers "roughly then", which is what they were asking.
  assert.strictEqual(Frames.indexNearest(FIRST, NOON - 86400), 0, "yesterday")
  assert.strictEqual(Frames.indexNearest(FIRST, NOON + 86400), 12, "tomorrow")
})

test("asking about an empty list is not an error", () => {
  assert.strictEqual(Frames.indexNearest([], NOON), -1)
  assert.strictEqual(Frames.indexNearest(null, NOON), -1)
})

// ------------------------------------------------------------------ latest

test("only the last frame is the latest one", () => {
  assert.strictEqual(Frames.isLatest(FIRST, 12), true)
  assert.strictEqual(Frames.isLatest(FIRST, 11), false)
  assert.strictEqual(Frames.isLatest(FIRST, 0), false)
  assert.strictEqual(Frames.isLatest([], 0), false)
  assert.strictEqual(Frames.isLatest(null, 0), false)
})

// ------------------------------------------------------------------ reselect

test("someone parked on the newest frame stays on the newest frame", () => {
  const later = listEndingAt(NOON + 3600, 13)
  assert.strictEqual(Frames.reselect(later, NOON, true), 12)
})

test("staying on the newest survives the list changing length", () => {
  // Regression: the rule used to compare the held index against the new list's
  // length, so a list that grew left somebody who had chosen the newest frame
  // silently one frame behind — visible only as a timestamp that was not the
  // one they left on.
  for (const count of [12, 13, 14, 20, 1]) {
    const later = listEndingAt(NOON + 7200, count)
    assert.strictEqual(Frames.reselect(later, NOON, true), count - 1, `${count} frames`)
  }
})

test("someone who scrubbed back keeps the moment they scrubbed to", () => {
  const wanted = FIRST[4].time
  // Half an hour later the window has moved on by three frames.
  const later = listEndingAt(NOON + 1800, 13)
  const index = Frames.reselect(later, wanted, false)
  assert.strictEqual(later[index].time, wanted, "the same moment, at its new index")
  assert.strictEqual(index, 1)
})

test("a moment that has aged out of the window lands on the oldest frame", () => {
  // Hours later nothing they were looking at is published any more. The oldest
  // frame is the closest thing to it, and is honest about being the edge.
  const later = listEndingAt(NOON + 4 * 3600, 13)
  assert.strictEqual(Frames.reselect(later, NOON, false), 0)
})

test("with nothing to carry forward, the newest frame is the answer", () => {
  assert.strictEqual(Frames.reselect(FIRST, 0, false), 12)
  assert.strictEqual(Frames.reselect(FIRST, NaN, false), 12)
  assert.strictEqual(Frames.reselect(FIRST, -1, false), 12)
})

test("reselecting against an empty list yields no frame", () => {
  assert.strictEqual(Frames.reselect([], NOON, true), -1)
  assert.strictEqual(Frames.reselect(null, NOON, false), -1)
})

test("the panel's whole journey ends where it started", () => {
  // Open, park on the newest, close, reopen hours later: the newest again.
  let shown = FIRST[12].time
  let following = true
  for (const hours of [1, 3, 9]) {
    const later = listEndingAt(NOON + hours * 3600, 13)
    const index = Frames.reselect(later, shown, following)
    assert.strictEqual(index, 12, `${hours}h later`)
    assert.strictEqual(later[index].time, NOON + hours * 3600, "and it is the current one")
    shown = later[index].time
    following = Frames.isLatest(later, index)
  }
})

// ------------------------------------------------------------------ playback

test("playback steps forward and loops at the end", () => {
  assert.strictEqual(Frames.nextIndex(FIRST, 0), 1)
  assert.strictEqual(Frames.nextIndex(FIRST, 11), 12)
  assert.strictEqual(Frames.nextIndex(FIRST, 12), 0, "the loop restarts")
  assert.strictEqual(Frames.nextIndex(FIRST, 99), 0, "so does an index past the end")
  assert.strictEqual(Frames.nextIndex(FIRST, -5), 0)
  assert.strictEqual(Frames.nextIndex([], 0), -1)
})

test("an index chosen against another list is clamped before it is read", () => {
  assert.strictEqual(Frames.clampIndex(FIRST, 20), 12)
  assert.strictEqual(Frames.clampIndex(FIRST, -3), 0)
  assert.strictEqual(Frames.clampIndex(FIRST, 5), 5)
  assert.strictEqual(Frames.clampIndex([], 5), -1)
})
