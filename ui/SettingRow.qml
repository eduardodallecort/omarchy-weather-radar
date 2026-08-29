import QtQuick
import qs.Commons

// One row of the panel's control stack: a name, a line of prose under it, and
// a control on the right.
//
// The caption is not decoration. Every control here buys one thing at the cost
// of another — a wider radius is more warning and more false alarms, a lower
// threshold is more notice and more noise — and stating that where the control
// is set is worth more than a paragraph in the README.
Item {
  id: root

  // The bar this panel belongs to. `bar.foreground` already resolves the
  // surface for where the panel is mounted, which the global colour does not.
  property var bar: null

  property string label: ""
  property string caption: ""

  // Whatever is declared inside a SettingRow becomes its control, laid out
  // against the right edge.
  default property alias control: holder.data

  readonly property color foreground: bar ? bar.foreground : Color.foreground

  height: Style.spacing.controlHeight

  Column {
    anchors.left: parent.left
    anchors.leftMargin: Style.space(12)
    anchors.verticalCenter: parent.verticalCenter
    spacing: 1

    Text {
      text: root.label
      color: root.foreground
      font.family: Style.font.family
      font.pixelSize: Style.font.body
    }

    Text {
      text: root.caption
      color: root.foreground
      font.family: Style.font.family
      font.pixelSize: Style.font.caption
      opacity: 0.55
      visible: text !== ""
    }
  }

  Item {
    id: holder
    anchors.right: parent.right
    anchors.rightMargin: Style.space(12)
    anchors.verticalCenter: parent.verticalCenter
    width: childrenRect.width
    height: childrenRect.height
  }
}
