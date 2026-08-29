// Reading the widget's settings.
//
// Settings persist inline on the widget's entry in shell.json, so every value
// arrives as whatever JSON happened to be there: a number the user typed, a
// string from an older version, a key that does not exist yet, or nothing at
// all while the shell is still injecting them. Coercion therefore belongs in
// one place rather than at each reading site — the panel and the service used
// to clamp the alert radius independently, which is two chances to disagree
// about the same number.
//
// DEFAULTS mirrors `barWidget.defaults` in manifest.json, and a test holds the
// two together: the manifest is what a fresh install gets, and these are what
// the code falls back to, so a change to one without the other means new users
// and existing users run different plugins.

.pragma library

.import "RadarModel.js" as RadarModel
.import "Alerts.js" as Alerts

var DEFAULTS = {
  alertsEnabled: false,
  alertRadiusKm: 100,
  alertMinIntensity: "Heavy",
  colorScheme: "TITAN",
  defaultZoom: 7,
  smoothTiles: true,
  showSnow: true,
  showLabel: false
}

var RADIUS_MIN_KM = 25
var RADIUS_MAX_KM = 250
var RADIUS_STEP_KM = 25

// A widget is created before its settings are injected, so an empty object is
// the ordinary state for the first moments of a session. That state is "not
// known yet", not "every boolean is false", and the two must not be confused:
// treating it as false makes the arrival of real settings look like the user
// switching something on, which re-arms the alert latch and can announce the
// same weather twice.
function isReady(settings) {
  return !!settings && Object.keys(settings).length > 0
}

function read(settings, key) {
  if (settings && settings[key] !== undefined) return settings[key]
  return DEFAULTS[key]
}

function boolean(settings, key) {
  return read(settings, key) === true
}

function alertsEnabled(settings) {
  return isReady(settings) && boolean(settings, "alertsEnabled")
}

// parseFloat rather than Number, because Number(null) is 0 and a null radius
// would clamp to the minimum instead of falling back to the default.
function alertRadiusKm(settings) {
  var value = parseFloat(read(settings, "alertRadiusKm"))
  if (!isFinite(value)) value = DEFAULTS.alertRadiusKm
  return Math.max(RADIUS_MIN_KM, Math.min(RADIUS_MAX_KM, Math.round(value)))
}

function alertThreshold(settings) {
  var name = String(read(settings, "alertMinIntensity"))
  return Alerts.THRESHOLD_OPTIONS.indexOf(name) === -1 ? DEFAULTS.alertMinIntensity : name
}

function schemeIdNamed(name) {
  for (var i = 0; i < RadarModel.COLOR_SCHEMES.length; i++) {
    if (RadarModel.COLOR_SCHEMES[i].name === name) return RadarModel.COLOR_SCHEMES[i].id
  }
  return -1
}

// Falling back by looking the default up again rather than by calling this
// function again. The recursive form has its base case in another file — it
// ends only because DEFAULTS.colorScheme happens to name a scheme in
// RadarModel — and renaming one without the other would not produce a wrong
// colour, it would overflow the stack while the panel is being built.
function colorSchemeId(settings) {
  var chosen = schemeIdNamed(String(read(settings, "colorScheme")))
  if (chosen >= 0) return chosen

  var fallback = schemeIdNamed(DEFAULTS.colorScheme)
  return fallback >= 0 ? fallback : RadarModel.COLOR_SCHEMES[0].id
}

function defaultZoom(settings) {
  var value = parseFloat(read(settings, "defaultZoom"))
  if (!isFinite(value)) value = DEFAULTS.defaultZoom
  return Math.max(RadarModel.MIN_RADAR_ZOOM, Math.min(RadarModel.MAX_MAP_ZOOM, Math.round(value)))
}

function smoothTiles(settings) { return boolean(settings, "smoothTiles") }
function showSnow(settings) { return boolean(settings, "showSnow") }
function showLabel(settings) { return boolean(settings, "showLabel") }

// The alert radius is offered in the panel as a few presets rather than as a
// free number. The radius is really a question about warning time, and storms
// travel anywhere from 40 to 60 km/h, so treating 137 km as meaningfully
// different from 150 would be precision the underlying model does not have.
//
// The settings form still takes any value in 25 km steps, and a value set
// there that is not a preset is added to the list rather than silently
// dropped — a control that cannot represent its own current value is a control
// that changes it the moment anyone touches it.
var RADIUS_PRESETS_KM = [50, 100, 150, 200]

function radiusPresets(radiusKm) {
  var presets = RADIUS_PRESETS_KM.slice()
  if (presets.indexOf(radiusKm) === -1) {
    presets.push(radiusKm)
    presets.sort(function(a, b) { return a - b })
  }
  return presets.map(function(km) { return String(km) })
}
