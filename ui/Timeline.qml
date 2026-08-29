import QtQuick
import qs.Commons
import qs.Ui
import "../lib/Glyphs.js" as Glyphs

// Transport for the two-hour radar loop: play/pause, a scrubber over the
// available frames, and the timestamp of the one on screen.
//
// The panel owns playback state; this reports intent and renders what it is
// given, so the same state drives the keyboard shortcuts without a second copy
// of it living down here.
Item {
  id: root

  // The bar this panel belongs to. `bar.foreground` already resolves the
  // surface for where the panel is mounted, which the global colour does not.
  property var bar: null

  property var frames: []
  property int frameIndex: 0
  property bool playing: false
  property string frameLabel: "--:--"
  property bool isLatestFrame: true

  signal playToggled()
  signal frameRequested(int index)

  readonly property color foreground: bar ? bar.foreground : Color.foreground

  height: Style.spacing.controlHeight
  visible: frames.length > 1

  Button {
    id: playButton
    anchors.left: parent.left
    anchors.leftMargin: Style.space(8)
    anchors.verticalCenter: parent.verticalCenter
    text: root.playing ? Glyphs.PAUSE : Glyphs.PLAY
    fontFamily: Style.font.family
    foreground: root.foreground
    tooltipText: root.playing ? "Pause (Enter)" : "Play the last two hours (Enter)"
    onClicked: root.playToggled()
  }

  PanelSlider {
    id: timeline
    anchors.left: playButton.right
    anchors.right: frameTime.left
    anchors.leftMargin: Style.space(8)
    anchors.rightMargin: Style.space(10)
    anchors.verticalCenter: parent.verticalCenter
    bar: root.bar
    minimum: 0
    maximum: Math.max(1, root.frames.length - 1)
    integer: true
    step: 1
    tickCount: root.frames.length
    value: root.frameIndex
    onMoved: function(value) { root.frameRequested(Math.round(value)) }
  }

  // Fixed width, and no suffix that appears and disappears. The label sits at
  // the end of the slider's anchor chain, so any change to its width resizes
  // the track — which, mid-drag, slides the knob out from under the pointer. A
  // clock that only ever renders five characters cannot do that, and the
  // timestamp already says whether you are looking at the past.
  Text {
    id: frameTime
    anchors.right: parent.right
    anchors.rightMargin: Style.space(10)
    anchors.verticalCenter: parent.verticalCenter
    width: Style.space(44)
    horizontalAlignment: Text.AlignRight
    text: root.frameLabel
    color: root.foreground
    font.family: Style.font.family
    font.pixelSize: Style.font.caption
    opacity: root.isLatestFrame ? 0.9 : 0.6
  }
}
