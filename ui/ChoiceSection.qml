import QtQuick
import qs.Commons
import qs.Ui

// One of N, laid out the way the first-party panels lay out a choice: a
// small-caps heading naming it, a line of prose saying what it costs, and a row
// of equal-width buttons filling the panel.
//
// Equal width is the point. Buttons sized to their own text leave a ragged row,
// and two ragged rows stacked read as a table that does not line up — which is
// what a panel of controls should never look like. The cell width is computed
// from the row rather than from the labels, so "50" and "Moderate" occupy the
// same box and the two rows agree with each other.
//
// This is the power panel's POWER PROFILE section; ButtonGroup, which the
// settings forms use, is not a panel pattern.
Column {
  id: root

  property var bar: null
  property string title: ""
  property string caption: ""

  // Plain strings: the label is the value.
  property var options: []
  property string value: ""

  signal chosen(string value)

  readonly property color foreground: bar ? bar.foreground : Color.foreground

  spacing: Style.space(6)

  PanelSectionHeader {
    text: root.title
    foreground: root.foreground
    fontFamily: Style.font.family
  }

  // The trade-off, where the control is, rather than in the README.
  Text {
    textFormat: Text.PlainText
    width: parent.width
    visible: root.caption !== ""
    text: root.caption
    color: root.foreground
    font.family: Style.font.family
    font.pixelSize: Style.font.caption
    opacity: 0.55
    elide: Text.ElideRight
  }

  Row {
    id: cells
    width: parent.width
    spacing: Style.space(6)

    readonly property real cellWidth: root.options.length > 0
      ? (width - spacing * (root.options.length - 1)) / root.options.length
      : 0

    Repeater {
      model: root.options

      Button {
        required property var modelData

        width: cells.cellWidth
        text: String(modelData)
        fontSize: Style.font.bodySmall
        fontFamily: Style.font.family
        foreground: root.foreground
        background: root.bar ? root.bar.background : Color.background
        bordered: true
        active: String(modelData) === root.value
        onClicked: root.chosen(String(modelData))
      }
    }
  }
}
