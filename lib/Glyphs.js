// Every Nerd Font glyph the plugin draws, defined once.
//
// Two traps make a scattered glyph a liability. A JavaScript `\u` escape
// consumes exactly four hex digits, and every glyph here sits above U+FFFF, so
// the escape spelling silently yields a different character followed by a
// stray digit — which is why these are built from codepoints. And Nerd Fonts
// renumbered its ranges between major versions, so a codepoint remembered from
// a cheat sheet very often draws something else now, with the font containing
// a glyph at that position either way.
//
// The names below are the registry's own, resolved from glyphnames.json rather
// than assumed. A test asserts each constant is a single codepoint.

.pragma library

var RADAR = String.fromCodePoint(0xF0437)           // md-radar
var PLAY = String.fromCodePoint(0xF040A)            // md-play
var PAUSE = String.fromCodePoint(0xF03E4)           // md-pause
var PENCIL = String.fromCodePoint(0xF03EB)          // md-pencil
var PROGRESS_CLOCK = String.fromCodePoint(0xF0996)  // md-progress_clock
var RECENTER = String.fromCodePoint(0xF01A4)        // md-crosshairs_gps
