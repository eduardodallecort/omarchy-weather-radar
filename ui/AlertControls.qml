import QtQuick
import qs.Commons
import qs.Ui
import "../lib/Alerts.js" as Alerts

// The storm alert controls, in the panel rather than only in the settings
// form: turning the watch on is one click from the thing you are looking at,
// the way the audio panel keeps its mute switch beside the thing it mutes.
//
// Laid out as the network panel lays out its band section — a heading, the
// switch that governs everything under it on the same line, and the choices
// below.
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

  // The heading and the line under it are one block, with the switch centred
  // against the whole of it rather than against the heading alone. The two
  // lines say what the watch is and what it is doing, which is a single thing;
  // separating them by a section gap read as two, and left the switch floating
  // beside the first.
  Item {
    width: parent.width
    implicitHeight: Math.max(alertsHeading.implicitHeight, alertsSwitch.implicitHeight)

    Column {
      id: alertsHeading
      anchors.left: parent.left
      anchors.right: alertsSwitch.left
      anchors.rightMargin: Style.space(8)
      anchors.verticalCenter: parent.verticalCenter
      spacing: Style.space(2)

      PanelSectionHeader {
        id: alertsHeader
        text: "STORM ALERTS"
        foreground: root.foreground
        fontFamily: Style.font.family
      }

      // What the watch is actually doing. Aligned with the heading, like every
      // other caption in the panel — it belongs to it rather than to the rows
      // below.
      Text {
        textFormat: Text.PlainText
        width: parent.width
        text: root.alertStatus
        color: root.foreground
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
        opacity: 0.55
        elide: Text.ElideRight
      }
    }

    // At the size the rest of the shell gives a switch. The network panel
    // shrinks its own to the heading's font, which is right for a modifier
    // qualifying the choice below it; this one is the panel's primary control.
    ToggleSwitch {
      id: alertsSwitch
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      checked: root.alertsEnabled
      busy: root.alertsEnabled && root.radar ? root.radar.checking : false
      foreground: root.foreground
      onToggled: root.alertsToggled()
    }
  }

  // Only while alerts are on: with them off there is nothing to tune, and the
  // rings this controls are not drawn either.
  // Only while alerts are on: with them off there is nothing to tune, and the
  // rings these control are not drawn either.
  ChoiceSection {
    width: parent.width
    visible: root.alertsEnabled
    bar: root.bar
    title: "ALERT RADIUS"
    // The kilometres are what the rings show; the hours are what the number
    // actually means. Saying both keeps the control honest about being an
    // approximation.
    caption: "about " + Alerts.humanizeLead(root.alertLeadMinutes) + " of warning"
    options: root.radiusPresets
    value: String(root.alertRadiusKm)
    onChosen: function(picked) {
      var km = parseInt(picked, 10)
      if (isFinite(km) && km !== root.alertRadiusKm) root.radiusChosen(km)
    }
  }

  // The radius decides how far ahead to look; this decides how bad it has to
  // be to be worth interrupting for. Without it, a two-hour window in a wet
  // season would fire on every passing shower, and the plugin would be
  // switched off — taking the alert that mattered with it.
  ChoiceSection {
    width: parent.width
    visible: root.alertsEnabled
    bar: root.bar
    title: "NOTIFY ME ABOUT"
    caption: Alerts.thresholdCaption(root.alertThreshold)
    options: root.thresholdOptions
    value: root.alertThreshold
    onChosen: function(picked) {
      if (picked !== root.alertThreshold) root.thresholdChosen(picked)
    }
  }
}
