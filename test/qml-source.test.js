// What the QML says about itself.
//
// The rest of the suite runs the plugin's plain functions. These files cannot
// be run here at all — they need a QML engine and the shell's own modules — so
// what is checked is the source, and only claims a reader could verify by
// looking. test/text-format.sh renders the same strings under Qt and watches a
// socket, which is what turns these into evidence rather than intent.

const { test } = require("node:test")
const assert = require("node:assert")
const { readFileSync, readdirSync } = require("node:fs")
const { join } = require("node:path")

const ROOT = join(__dirname, "..")

function qmlFiles() {
  const here = readdirSync(ROOT).filter(name => name.endsWith(".qml"))
  const ui = readdirSync(join(ROOT, "ui")).filter(name => name.endsWith(".qml"))
  return [...here.map(n => n), ...ui.map(n => join("ui", n))]
}

function read(relative) {
  return readFileSync(join(ROOT, relative), "utf8")
}

// QML's Text defaults to Text.AutoText, which decides per string whether it is
// markup — so a place name shaped like an img tag is parsed as one and its
// source is fetched by the process that owns the bar, the panels and the lock
// screen. Three of these render strings this plugin did not write: the stored
// location name, and the name and description of a geocoding suggestion.
//
// The rule is every Text rather than only those three, because which value
// reaches which label changes with every edit, and a rule with exceptions is a
// rule somebody has to re-derive before adding a component.
test("every Text element declares Text.PlainText", () => {
  const offenders = []

  for (const relative of qmlFiles()) {
    const lines = read(relative).split("\n")
    lines.forEach((line, index) => {
      if (!/^\s*Text\s*\{\s*$/.test(line)) return
      // The declaration is required inside the block, not necessarily on the
      // next line: what matters is that the element carries it before its
      // properties are read, and a block is short enough to look at whole.
      const block = lines.slice(index, index + 30).join("\n")
      const end = block.indexOf("\n  }")
      const body = end === -1 ? block : block.slice(0, end)
      if (!/textFormat\s*:\s*Text\.PlainText/.test(body)) {
        offenders.push(`${relative}:${index + 1}`)
      }
    })
  }

  assert.deepStrictEqual(offenders, [],
    "a Text left on the default parses markup out of whatever it is given")
})

// A count, so that deleting the elements is not a way to pass the rule above.
test("the plugin still renders text", () => {
  const total = qmlFiles()
    .map(relative => (read(relative).match(/^\s*Text\s*\{\s*$/gm) || []).length)
    .reduce((sum, n) => sum + n, 0)

  assert.ok(total >= 10, `only ${total} Text elements found`)
})

// The one string that leaves this plugin for a component it does not own. The
// body is rendered by Omarchy's NotificationCard with Text.StyledText, which
// text-format.sh measures as fetching the source of an img tag.
test("the notification body makes the place name inert", () => {
  const source = read(join("lib", "Alerts.js"))
  assert.match(source, /description \+= " at " \+ inertText\(locationName\)/,
    "the place name reaches the notification body without being made inert")
})
