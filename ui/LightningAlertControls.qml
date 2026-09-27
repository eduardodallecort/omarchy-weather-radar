import QtQuick
import qs.Commons
import qs.Ui

// The lightning watch, laid out like the storm alerts above it: a heading
// with its switch, what the watch is doing, and the radius under it.
//
// Nothing here writes a setting; the panel persists what is asked for.
Column {
  id: root

  property var bar: null
  property var radar: null

  property bool enabled_: false
  property int radiusMiles: 50
  property var radiusPresets: []

  signal toggled()
  signal radiusChosen(int miles)

  readonly property color foreground: bar ? bar.foreground : Color.foreground

  Item {
    width: parent.width
    implicitHeight: Math.max(heading.implicitHeight, toggle.implicitHeight)

    Column {
      id: heading
      anchors.left: parent.left
      anchors.right: toggle.left
      anchors.rightMargin: Style.space(8)
      anchors.verticalCenter: parent.verticalCenter
      spacing: Style.space(2)

      PanelSectionHeader {
        text: "LIGHTNING ALERTS"
        foreground: root.foreground
        fontFamily: Style.font.family
      }

      Text {
        textFormat: Text.PlainText
        width: parent.width
        text: root.radar ? root.radar.lightningStatus : "off"
        color: root.foreground
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
        opacity: 0.55
        elide: Text.ElideRight
      }
    }

    ToggleSwitch {
      id: toggle
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      checked: root.enabled_
      foreground: root.foreground
      onToggled: root.toggled()
    }
  }

  ChoiceSection {
    width: parent.width
    visible: root.enabled_
    bar: root.bar
    title: "LIGHTNING RADIUS (MILES)"
    caption: "notify when a strike lands within " + root.radiusMiles + " miles, with its direction"
    options: root.radiusPresets
    value: String(root.radiusMiles)
    onChosen: function(picked) {
      var mi = parseInt(picked, 10)
      if (isFinite(mi) && mi !== root.radiusMiles) root.radiusChosen(mi)
    }
  }
}
