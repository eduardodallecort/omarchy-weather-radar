#!/usr/bin/env bash
#
# That a place name cannot make the shell fetch a URL.
#
# The panel renders three strings this plugin did not write: the stored
# location name, and the name and description of every geocoding suggestion.
# The first is the shared `weather.json`, which anything on the machine can
# write and the README invites people to hand-edit; the others come off the
# network. QML's `Text` defaults to `Text.AutoText`, which decides per string
# whether it is markup, so a name shaped like an `<img>` tag is parsed as one
# and its source is fetched by the process that owns the bar, the panels and
# the lock screen.
#
# test/qml-source.test.js checks that every `Text` in the plugin declares
# `Text.PlainText`. That is source inspection: it assumes the declaration
# works. This renders the strings and watches a socket, so the claim rests on
# what Qt does rather than on what the source says.
#
# The first case is a control that must *fetch*. Without it a broken beacon
# would report every case as safe.
#
# The third case is not this plugin's QML at all. The alert body ends with
# "at <name>", and Omarchy's own NotificationCard renders it with
# `Text.StyledText` — so what that mode does with an `<img>` tag decides
# whether a name has to be made inert before it is handed over. Measured here
# rather than assumed from the documentation.
#
# Needs `qml6` from qt6-declarative, which Quickshell depends on, and python3
# for the listener. Skips without them unless RADAR_REQUIRE_QS is set, which is
# how CI turns the skip into a failure.

set -uo pipefail

cd "$(dirname "$0")/.."

require() {
  command -v "$1" > /dev/null 2>&1 && return 0
  if [[ -n ${RADAR_REQUIRE_QS:-} ]]; then
    echo "RADAR_REQUIRE_QS is set and there is no $1 on PATH" >&2
    exit 1
  fi
  echo "no $1 on PATH; skipping (set RADAR_REQUIRE_QS to make this fatal)"
  exit 0
}

require qml6
require python3

work=$(mktemp -d)
trap 'rm -rf "$work"; kill %1 2> /dev/null' EXIT

pass=0
fail=0

check() {
  if [[ $2 == "$3" ]]; then
    pass=$((pass + 1))
    printf '  ok    %s\n' "$1"
  else
    fail=$((fail + 1))
    printf '  FAIL  %s\n          wanted: %s\n          got:    %s\n' "$1" "$3" "$2" >&2
  fi
}

# ------------------------------------------------------------- the listener
#
# Port 0 so two copies of the suite can run at once, and so a port left open by
# a previous run cannot make this one look safe. Every request is a line in
# hits; the QML side names each case in its path.
cat > "$work/beacon.py" <<'PY'
import http.server, socketserver, sys

hits, port_file, limit = sys.argv[1], sys.argv[2], int(sys.argv[3])

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        with open(hits, "a") as f:
            f.write(self.path + "\n")
        self.send_response(404)
        self.end_headers()
    def log_message(self, *a):
        pass

socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("127.0.0.1", 0), Handler) as server:
    with open(port_file, "w") as f:
        f.write(str(server.server_address[1]))
    server.timeout = 0.5
    for _ in range(limit):
        server.handle_request()
PY

: > "$work/hits"
python3 "$work/beacon.py" "$work/hits" "$work/port" 40 &

for _ in $(seq 20); do
  [[ -s $work/port ]] && break
  sleep 0.2
done
port=$(cat "$work/port" 2> /dev/null)

if [[ -z $port ]]; then
  echo "the listener never came up" >&2
  exit 1
fi

# ---------------------------------------------------------------- the probe
#
# The payload is the shape a real one would take: a plausible place name
# followed by the tag, so the entry looks ordinary in the stock weather widget
# that shares this file.
cat > "$work/probe.qml" <<QML
import QtQuick
import "$PWD/lib/Alerts.js" as Alerts

Window {
  id: probe

  width: 600
  height: 400
  visible: true

  readonly property string hostile:
    'Springfield<img src="http://127.0.0.1:$port/%1.png">'

  // Control: this one must fetch, or the checks below prove nothing.
  Text { text: probe.hostile.arg("CONTROL") }

  // What every Text in this plugin now declares.
  Text {
    y: 40
    text: probe.hostile.arg("PLAINTEXT")
    textFormat: Text.PlainText
  }

  // Not this plugin's QML: the mode Omarchy's NotificationCard uses for the
  // body this plugin sends, which ends with the place name. Left on
  // StyledText deliberately — this measures the mode, and is expected to
  // fetch. It is the reason the case below exists.
  Text {
    y: 80
    text: probe.hostile.arg("STYLED")
    textFormat: Text.StyledText
  }

  // The name after Alerts.inertText, in that same mode. This is the one that
  // has to stay silent: it is what the notification body actually carries,
  // rendered the way the shell actually renders it.
  Text {
    y: 120
    text: Alerts.inertText(probe.hostile.arg("INERT"))
    textFormat: Text.StyledText
  }

  Timer { interval: 2500; running: true; onTriggered: Qt.quit() }
}
QML

QT_QPA_PLATFORM=offscreen qml6 "$work/probe.qml" > "$work/qml.log" 2>&1
sleep 2

fetched() { grep -qF "/$1.png" "$work/hits"; }

if ! fetched CONTROL; then
  echo "the control never fetched — the probe did not render, so nothing below is evidence" >&2
  sed -n '1,20p' "$work/qml.log" >&2
  exit 1
fi
check "a default Text fetches the URL in a hostile place name" "yes" "yes"

fetched PLAINTEXT && got=fetched || got=silent
check "Text.PlainText does not fetch" "$got" "silent"

# Not a failure: the reason the next check exists. Asserted rather than
# ignored, so that a Qt release which stops fetching here is noticed as a
# change in the ground this plugin stands on rather than passing silently.
fetched STYLED && got=fetched || got=silent
check "Text.StyledText fetches, which is the mode the notification card uses" "$got" "fetched"

fetched INERT && got=fetched || got=silent
check "an inert place name does not fetch, even at StyledText" "$got" "silent"

echo "$pass passed, $fail failed"
[[ $fail -eq 0 ]]
