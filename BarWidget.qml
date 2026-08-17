import QtQuick
import qs.Commons
import "RadarModel.js" as RadarModel
import qs.Ui

// Bar pill for the radar plugin.
//
// Structure follows the first-party pattern (see plugins/panels/weather):
// the widget owns the button and lazily loads the panel, forwarding the
// open/close contract the bar's popout coordinator expects. All state comes
// from the plugin's service, so two monitors show the same thing without
// either of them polling.
BarWidget {
  id: root
  moduleName: "eduardodallecort.weather-radar"

  readonly property var radar: bar && bar.shell ? bar.shell.serviceFor("eduardodallecort.weather-radar") : null

  // Defined in RadarModel so the bar and the notification cannot drift.
  readonly property string icon: RadarModel.GLYPH

  readonly property bool showLabel: setting("showLabel", false) === true
  readonly property string summary: radar ? radar.barSummary : ""
  readonly property int outlookLevel: radar ? radar.outlookLevel : 0

  readonly property color defaultForeground: bar ? bar.foreground : Color.foreground

  // Tint the pill when weather is on the way, the same way the stock
  // indicators signal state: accent for something worth knowing, urgent for a
  // severe outlook. Anything below that stays the ordinary bar foreground so
  // the bar does not become a christmas tree.
  readonly property color iconColor: {
    if (!radar || !radar.alertsEnabled) return defaultForeground
    if (outlookLevel >= 4) return Color.urgent
    if (outlookLevel >= 3) return Color.accent
    return defaultForeground
  }

  // The shell injects `settings` into widgets but not into services, so the
  // widget forwards them. On a multi-monitor setup every bar instance writes
  // the same value, which is harmless — they all read the same shell.json
  // entry.
  function syncService() {
    if (root.radar && "settings" in root.radar) root.radar.settings = root.settings
  }

  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    if ("bar" in target) target.bar = root.bar
    if ("settings" in target) target.settings = root.settings
    if ("anchorItem" in target) target.anchorItem = button
    if ("hostWidget" in target) target.hostWidget = root
    if ("radar" in target) target.radar = root.radar
  }

  function togglePanel() {
    if (panelLoader.item && panelLoader.item.toggle) panelLoader.item.toggle()
  }

  // Shape contract for shell.summon/hide/toggle routing: the bar identifies a
  // panel by the widget mounted in its slot, so open/close/opened have to live
  // on this root rather than on the nested panel.
  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false

  function open() {
    if (panelLoader.item && panelLoader.item.openFromHotkey) panelLoader.item.openFromHotkey()
  }

  function close() {
    if (panelLoader.item && panelLoader.item.close) panelLoader.item.close()
  }

  readonly property bool popoutSwitchClosing: panelLoader.item ? panelLoader.item.popoutSwitchClosing === true : false

  function closeForPopoutSwitch() {
    if (panelLoader.item) panelLoader.item.closeForPopoutSwitch()
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onBarChanged: injectPanel()
  onSettingsChanged: { injectPanel(); syncService() }
  onRadarChanged: { injectPanel(); syncService() }

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    // The label prints the alert's own outlook, so with alerts off there is
    // nothing for it to say and the icon stands alone.
    text: root.showLabel && root.summary !== "" ? root.icon + "  " + root.summary : root.icon
    foreground: root.iconColor
    slotSize: Style.bar.statusSlot
    tooltipText: ""

    onPressed: function(b) {
      if (b === Qt.MiddleButton && root.radar) root.radar.checkNow()
      else root.togglePanel()
    }
  }
}
