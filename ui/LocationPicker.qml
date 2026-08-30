import QtQuick
import qs.Commons
import qs.Ui
import "../lib/Glyphs.js" as Glyphs

// The location row and its search results, mirroring the stock weather
// widget's picker so both offer the same candidates for the same query.
//
// The location itself belongs to Omarchy, not to this plugin: it lives in
// omarchy-weather-location's own state file, which the stock weather widget
// reads too. Nothing here writes it. The panel does the saving, and only
// because the user asked — a plugin that wrote shared state on its own opinion
// would be overwriting configuration it does not own.
Column {
  id: root

  property var bar: null

  property string locationName: ""
  property string locationState: "unset"
  property bool coverageMissing: false

  property bool editing: false
  property bool saving: false
  property var suggestions: []
  property int suggestionIndex: 0

  // The search text. The panel reads it to commit and writes it to seed the
  // field, so it is exposed rather than mirrored.
  property alias query: locationField.text

  signal editRequested()
  signal cancelRequested()
  signal commitRequested()
  signal clearRequested()
  signal queryEdited()
  signal suggestionHighlighted(int index)
  signal suggestionPicked(var suggestion)

  readonly property color foreground: bar ? bar.foreground : Color.foreground

  function focusQuery() {
    locationField.forceActiveFocus()
  }

  Item {
    width: parent.width
    height: Style.spacing.controlHeight

    // Resting state: the city name, click to change it.
    Row {
      visible: !root.editing
      anchors.left: parent.left
      anchors.verticalCenter: parent.verticalCenter
      spacing: Style.space(8)

      Text {
        anchors.verticalCenter: parent.verticalCenter
        text: root.locationName !== "" ? root.locationName : "Set a location"
        color: root.foreground
        font.family: Style.font.family
        font.pixelSize: Style.font.body
        opacity: root.locationName !== "" ? 1 : 0.6
      }

      Text {
        anchors.verticalCenter: parent.verticalCenter
        text: Glyphs.PENCIL
        color: root.foreground
        font.family: Style.font.family
        font.pixelSize: Style.font.bodySmall
        opacity: 0.45
      }

      // Both sit beside the city rather than over the map: they are facts
      // about the configured location, not about whatever the view happens to
      // be showing, and a message centred on a map that can be panned anywhere
      // would claim the latter.
      //
      // A name saved with nothing picked behind it is stored, and is a
      // location for the stock weather widget, which resolves names itself.
      // Here it is a name and nothing else — no point to centre on, no
      // coordinate to forecast for — and the map going quiet is otherwise the
      // only sign of it.
      Text {
        anchors.verticalCenter: parent.verticalCenter
        visible: root.locationState === "unresolved"
        text: "· no coordinates — pick one from the list"
        color: Color.urgent
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
        opacity: 0.9
      }

      Text {
        anchors.verticalCenter: parent.verticalCenter
        visible: root.coverageMissing
        text: "· no radar coverage"
        color: Color.urgent
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
        opacity: 0.9
      }
    }

    MouseArea {
      anchors.fill: parent
      visible: !root.editing
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      onClicked: root.editRequested()
    }

    Row {
      visible: root.editing
      anchors.left: parent.left
      anchors.verticalCenter: parent.verticalCenter
      spacing: Style.space(6)

      TextField {
        id: locationField
        width: Style.space(220)
        enabled: !root.saving
        placeholderText: "Search city"
        foreground: root.foreground
        font.family: Style.font.family

        onTextChanged: if (root.editing && !root.saving) root.queryEdited()

        Keys.onPressed: function(event) {
          if (event.key === Qt.Key_Escape) {
            root.cancelRequested()
            event.accepted = true
          } else if (event.key === Qt.Key_Down) {
            if (root.suggestionIndex < root.suggestions.length - 1) {
              root.suggestionHighlighted(root.suggestionIndex + 1)
            }
            event.accepted = true
          } else if (event.key === Qt.Key_Up) {
            if (root.suggestionIndex > 0) root.suggestionHighlighted(root.suggestionIndex - 1)
            event.accepted = true
          } else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
            root.commitRequested()
            event.accepted = true
          }
        }
      }

      // Clear back to IP auto-detect; becomes a spinner while saving.
      Rectangle {
        width: Style.space(18)
        height: Style.space(18)
        anchors.verticalCenter: parent.verticalCenter
        radius: Math.min(4, Style.cornerRadius)
        color: !root.saving && clearLocationArea.containsMouse
          ? Style.hoverFillFor(root.foreground, Color.accent)
          : "transparent"

        Text {
          anchors.centerIn: parent
          text: root.saving ? Glyphs.PROGRESS_CLOCK : "✕"
          font.family: Style.font.family
          color: Qt.darker(root.foreground, 1.4)
          font.pixelSize: Style.font.bodySmall

          RotationAnimator on rotation {
            running: root.saving
            from: 0
            to: 360
            duration: 800
            loops: Animation.Infinite
          }
        }

        MouseArea {
          id: clearLocationArea
          anchors.fill: parent
          hoverEnabled: true
          enabled: !root.saving
          cursorShape: Qt.PointingHandCursor
          onClicked: root.clearRequested()
        }
      }
    }
  }

  Column {
    width: parent.width
    spacing: 0
    visible: root.editing && !root.saving && root.suggestions.length > 0

    Repeater {
      model: root.suggestions

      Rectangle {
        required property var modelData
        required property int index

        readonly property bool highlighted: index === root.suggestionIndex

        width: parent.width
        height: suggestionRow.implicitHeight + Style.space(12)
        radius: Style.cornerRadius
        color: highlighted ? Style.hoverFillFor(root.foreground, Color.accent) : "transparent"

        Row {
          id: suggestionRow
          anchors.left: parent.left
          anchors.leftMargin: Style.space(6)
          anchors.verticalCenter: parent.verticalCenter
          spacing: Style.space(8)

          Text {
            text: modelData.name
            color: highlighted ? Style.hoverStateColor(root.foreground, Color.accent) : root.foreground
            font.family: Style.font.family
            font.pixelSize: Style.font.body
          }

          Text {
            visible: text !== ""
            text: modelData.description
            color: Qt.darker(root.foreground, 1.5)
            font.family: Style.font.family
            font.pixelSize: Style.font.bodySmall
            anchors.verticalCenter: parent.verticalCenter
          }
        }

        MouseArea {
          anchors.fill: parent
          hoverEnabled: true
          cursorShape: Qt.PointingHandCursor
          onPositionChanged: root.suggestionHighlighted(index)
          onClicked: root.suggestionPicked(modelData)
        }
      }
    }
  }
}
