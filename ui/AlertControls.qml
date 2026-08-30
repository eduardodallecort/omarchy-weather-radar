import QtQuick
import qs.Commons
import qs.Ui
import "../lib/Alerts.js" as Alerts

// The storm alert controls, in the panel rather than only in the settings
// form: turning the watch on is one click from the thing you are looking at,
// the same shape as the audio panel's mute switch.
//
// Nothing here writes a setting. Persisting belongs to the panel, which owns
// the shell entry; this reports what the user asked for.
Column {
  id: root

  property var bar: null

  // The service. Read for its live check state, never written to.
  property var radar: null

  property bool alertsEnabled: false
  property string locationState: "unset"
  property int alertLeadMinutes: 120
  property int alertRadiusKm: 100
  property var radiusPresets: []
  property string alertThreshold: "Heavy"
  property var thresholdOptions: []

  signal alertsToggled()
  signal radiusChosen(int km)
  signal thresholdChosen(string name)

  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color background: bar ? bar.background : Color.background

  // Proof the switch is doing something, rather than a silent toggle the user
  // has to take on faith. The wording lives in Alerts.alertStatus, which is
  // where it can be tested — it has been wrong twice.
  readonly property string alertStatus: Alerts.alertStatus({
    alertsEnabled: alertsEnabled,
    locationState: locationState,
    checking: radar ? radar.checking === true : false,
    everAnswered: radar ? radar.lastAnswerTime > 0 : false,
    failing: radar ? radar.consecutiveFailures > 0 : false,
    hasReading: radar ? radar.lastCheckTime > 0 : false,
    outlookLevel: radar ? radar.outlookLevel : 0,
    outlookLabel: radar ? radar.outlookLabel : "",
    outlookAtClock: radar ? radar.outlookAtClock : ""
  })

  SettingRow {
    width: parent.width
    bar: root.bar
    label: "Storm alerts"
    caption: root.alertStatus

    ToggleSwitch {
      checked: root.alertsEnabled
      busy: root.alertsEnabled && root.radar ? root.radar.checking : false
      foreground: root.foreground
      onToggled: root.alertsToggled()
    }
  }

  // Only while alerts are on: with them off there is nothing to tune, and the
  // rings this controls are not drawn either.
  SettingRow {
    width: parent.width
    bar: root.bar
    visible: root.alertsEnabled
    label: "Alert radius (km)"
    // The kilometres are what the rings show; the hours are what the number
    // actually means. Saying both keeps the control honest about being an
    // approximation.
    caption: "about " + Alerts.humanizeLead(root.alertLeadMinutes) + " of warning"

    ButtonGroup {
      options: root.radiusPresets
      value: String(root.alertRadiusKm)
      foreground: root.foreground
      background: root.background
      onChanged: function(value) {
        var km = parseInt(value, 10)
        if (isFinite(km) && km !== root.alertRadiusKm) root.radiusChosen(km)
      }
    }
  }

  // The radius decides how far ahead to look; this decides how bad it has to
  // be to be worth interrupting for. Without it, a two-hour window in a wet
  // season would fire on every passing shower, and the plugin would be
  // switched off — taking the alert that mattered with it.
  SettingRow {
    width: parent.width
    bar: root.bar
    visible: root.alertsEnabled
    label: "Notify me about"
    caption: Alerts.thresholdCaption(root.alertThreshold)

    ButtonGroup {
      options: root.thresholdOptions
      value: root.alertThreshold
      foreground: root.foreground
      background: root.background
      onChanged: function(value) {
        if (value !== root.alertThreshold) root.thresholdChosen(value)
      }
    }
  }
}
