# Shared by the shell tests in test/: sourced by them, never run on its own.
#
# Each of those tests runs real QML — the service under Quickshell, or a
# component under qml6 — in a temporary directory, offline, with the commands
# the plugin calls replaced on PATH. What is the same in all of them lives
# here, so that a convention changes in one place: how a missing runtime
# skips, how a check is reported, where the plugin is staged, how a probe runs
# and how what it reports is read back.
#
# After sourcing: `$plugin` is the repository, `$work` a directory removed on
# exit, `$work/bin` is first on the PATH probes run with, `$work/plugin` is
# where the probe and the staged plugin files live, and `$home` is an empty
# home for the service.

set -uo pipefail

plugin=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$plugin"

# A test needs a runtime this machine may not have. Skipping is right for
# someone running the suite without it, and wrong in CI, where
# RADAR_REQUIRE_QS makes the skip a failure rather than a pass for a check
# that never ran.
require() {
  local tool
  for tool in "$@"; do
    command -v "$tool" > /dev/null 2>&1 && continue
    if [[ -n ${RADAR_REQUIRE_QS:-} ]]; then
      echo "RADAR_REQUIRE_QS is set and there is no $tool on PATH" >&2
      exit 1
    fi
    echo "no $tool on PATH; skipping (set RADAR_REQUIRE_QS to make this fatal)"
    exit 0
  done
}

work=$(mktemp -d)
home=$work/home
mkdir -p "$work/bin" "$work/plugin" "$work/runtime" "$home"
# Made writable first, since a test may have taken the write bit away. A test
# with something of its own to stop, a listener say, puts it in `on_exit`.
on_exit=""
harness_exit() {
  [[ -n $on_exit ]] && eval "$on_exit"
  chmod -R u+w "$work" 2> /dev/null
  rm -rf "$work"
}
trap harness_exit EXIT

failures=0
check() {
  local label=$1 expected=$2 actual=$3
  if [[ $expected == "$actual" ]]; then
    printf '  ok    %s\n' "$label"
  else
    printf '  FAIL  %s (expected %s, got %s)\n' "$label" "$expected" "$actual"
    failures=$((failures + 1))
  fi
}

# The summary line, and the exit status CI reads.
finish() {
  echo
  if (( failures > 0 )); then
    echo "$1: $failures check(s) failed"
    exit 1
  fi
  echo "$1: all checks passed"
}

# A command on the probe's PATH, its script read from stdin.
fake() {
  cat > "$work/bin/$1"
  chmod +x "$work/bin/$1"
}

# `qs -p` treats the probe's directory as the root and refuses anything above
# it, so the real files are copied beside it instead of being reimplemented.
# `--basemap` brings the shipped ground as well.
stage_service() {
  cp "$plugin/Service.qml" "$work/plugin/"
  cp -r "$plugin/lib" "$work/plugin/"
  cp "$plugin/test/probe/Kit.qml" "$work/plugin/"
  if [[ ${1:-} == --basemap ]]; then
    mkdir -p "$work/plugin/data"
    cp "$plugin/data/basemap.bin" "$work/plugin/data/"
  fi
}

# A 256 px translucent PNG, a stand-in for any radar tile.
tile_png() {
  python3 - "$1" <<'PY'
import struct, sys, zlib
def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)
row = b"\x00" + bytes((40, 120, 220, 160)) * 256
open(sys.argv[1], "wb").write(b"\x89PNG\r\n\x1a\n"
    + chunk(b"IHDR", struct.pack(">IIBBBBB", 256, 256, 8, 6, 0, 0, 0))
    + chunk(b"IDAT", zlib.compress(row * 256)) + chunk(b"IEND", b""))
PY
}

# A RainViewer frame list, one frame every ten minutes from one moment to
# another, in epoch seconds.
manifest_json() {
  local t out=""
  for (( t = $1; t <= $2; t += 600 )); do out+="${out:+,}{\"time\":$t,\"path\":\"/v2/radar/$t\"}"; done
  printf '{"host":"https://tilecache.rainviewer.com","radar":{"past":[%s]}}' "$out"
}

# RainViewer, reduced to what the service asks of it, and switchable while a
# probe runs.
#
# The frame list comes back from `$work/plugin/current-manifest.json`. A batch
# of tiles is URL/-o pairs, answered the way real curl reports them. Each URL
# is logged to `$work/plugin/requests.log`, and each call to
# `$work/plugin/calls.log`. How it answers is read from two files on every call:
#
#   mode   ok        answers
#          down      no network at all: exit 7, no status
#          hang      answers the frame list, never finishes a batch
#          hanglist  never answers the frame list
#          full      a disk with no room: exit 23
#          slow      answers, a second and a half late for every batch
#   rules  lines of "<text in the URL> <answer>", the first match winning:
#          429       RainViewer's rate limit
#          timeout   nothing answered (exit 28, no status)
#          parity    429 in even tile columns, a timeout in odd ones
fake_rainviewer() {
  tile_png "$work/tile.png"
  echo ok > "$work/plugin/mode"
  : > "$work/plugin/rules"
  : > "$work/plugin/requests.log"
  : > "$work/plugin/calls.log"
  fake curl <<FAKE
#!/usr/bin/env python3
import os, shutil, sys, time
here = "$work/plugin"
mode = open(here + "/mode").read().strip()
rules = [line.split() for line in open(here + "/rules") if len(line.split()) == 2]
args = sys.argv[1:]
with open(here + "/calls.log", "a") as log:
    log.write(("batch " if "-o" in args else "manifest ") + mode + "\n")
if "-o" not in args:
    if not any("api.rainviewer.com" in a for a in args):
        sys.exit(22)
    if mode == "down":
        sys.exit(7)
    if mode == "hanglist":
        time.sleep(600)
    sys.stdout.write(open(here + "/current-manifest.json").read())
    sys.exit(0)
if mode == "hang":
    time.sleep(600)
if mode == "slow":
    time.sleep(1.5)
i = 0
while i < len(args):
    if not (args[i].startswith("https://") and i + 2 < len(args) and args[i + 1] == "-o"):
        i += 1
        continue
    url, path = args[i], args[i + 2]
    i += 3
    with open(here + "/requests.log", "a") as log:
        log.write(url + "\n")
    answer = next((a for text, a in rules if text in url), "ok")
    if answer == "parity":
        answer = "429" if int(url.split("/")[-4]) % 2 == 0 else "timeout"
    if mode == "down":
        print("7 000 " + path)
    elif mode == "full":
        print("23 200 " + path)
    elif answer == "429":
        print("22 429 " + path)
    elif answer == "timeout":
        print("28 000 " + path)
    else:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        shutil.copyfile("$work/tile.png", path)
        print("0 200 " + path)
    sys.stdout.flush()
FAKE
  fake omarchy-weather-location <<'FAKE'
#!/usr/bin/env bash
exit 0
FAKE
}

# Runs `$work/plugin/probe.qml` under Quickshell, offline and offscreen, for at
# most $1 seconds, with any further arguments passed to `env` (HOME in
# particular, which every caller decides). What the probe reports as
# "PROBE key=value" lines is read back with `value`; the whole output is in
# `$out` for diagnostics. XDG's cache and state variables are always unset, so
# nothing the machine running the test has set leaks into it. It runs from
# `$run_dir` when that is set, `$work` otherwise.
run_qs() {
  local seconds=$1; shift
  out=$(cd "${run_dir:-$work}" && env -u XDG_CACHE_HOME -u XDG_STATE_HOME "$@" PATH="$work/bin:$PATH" \
        QT_QPA_PLATFORM=offscreen XDG_RUNTIME_DIR="$work/runtime" \
        timeout "$seconds" qs -p "$work/plugin/probe.qml" 2>&1)
  probe=$(printf '%s\n' "$out" | sed -n 's/.*PROBE //p')
}

value() { printf '%s\n' "$probe" | sed -n "s/^$1=//p" | tail -1; }

# Stops the test when the probe did not get to the end, with what it said,
# rather than reporting every check after it as a failure of its own.
require_done() {
  if [[ $(value done) != "yes" ]]; then
    echo "  FAIL  the probe did not finish" >&2
    printf '%s\n' "$probe" >&2
    printf '%s\n' "$out" | grep -iE "error|warn|timeout" | head -20 >&2
    exit 1
  fi
}

# How many URLs a log holds between two marker lines a probe wrote, or from
# one to the end. Says "missing marker" rather than a count when either marker
# is not there exactly once, so a check on the window cannot pass because the
# window was never marked.
urls_between() { # file from [to]
  local file=$1 from=$2 to=${3:-}
  if [[ $(grep -cx "$from" "$file") != 1 || ( -n $to && $(grep -cx "$to" "$file") != 1 ) ]]; then
    echo "missing marker"
    return
  fi
  if [[ -n $to ]]; then
    sed -n "/^$from\$/,/^$to\$/p" "$file" | grep -c '^https'
  else
    sed -n "/^$from\$/,\$p" "$file" | grep -c '^https'
  fi
}

# Whether "n/total" is a whole, non-empty set: every one of total, and more
# than none.
all_of() { [[ ${1%/*} == "${1#*/}" && ${1#*/} -gt 0 ]] && echo yes || echo "no ($1)"; }
