const { test } = require("node:test")
const assert = require("node:assert")
const { loadLibrary } = require("./load.js")

const Glyphs = loadLibrary("Glyphs.js")

// The registry's own codepoints, from
// https://raw.githubusercontent.com/ryanoasis/nerd-fonts/master/glyphnames.json
// Nerd Fonts renumbered its ranges between major versions, so a codepoint
// remembered from a cheat sheet very often draws something else now — and the
// font contains a glyph at that position either way, so a coverage check
// confirms nothing. These were resolved by name rather than assumed.
const REGISTRY = {
  RADAR: [0xF0437, "md-radar"],
  PLAY: [0xF040A, "md-play"],
  PAUSE: [0xF03E4, "md-pause"],
  PENCIL: [0xF03EB, "md-pencil"],
  PROGRESS_CLOCK: [0xF0996, "md-progress_clock"],
  RECENTER: [0xF01A4, "md-crosshairs_gps"]
}

test("every glyph is exactly one character", () => {
  // A `\u` escape consumes exactly four hex digits, so writing any of these
  // that way yields a different glyph followed by a stray digit. Nothing
  // reports it; the icon is simply wrong.
  for (const name of Object.keys(REGISTRY)) {
    assert.strictEqual(Array.from(Glyphs[name]).length, 1, name)
  }
})

test("every glyph is the codepoint the registry gives for its name", () => {
  for (const [name, [codepoint, glyphName]] of Object.entries(REGISTRY)) {
    assert.strictEqual(Glyphs[name].codePointAt(0), codepoint,
      `${name} should be ${glyphName} at U+${codepoint.toString(16).toUpperCase()}`)
  }
})

test("every glyph sits in the range Nerd Fonts patches in", () => {
  for (const name of Object.keys(REGISTRY)) {
    const codepoint = Glyphs[name].codePointAt(0)
    assert.ok(codepoint > 0xFFFF, `${name} is at U+${codepoint.toString(16)}`)
  }
})

test("the constants and the checked list have not drifted apart", () => {
  // A glyph added to the library without a line here would ship unverified.
  assert.deepStrictEqual(Object.keys(Glyphs).sort(), Object.keys(REGISTRY).sort())
})
