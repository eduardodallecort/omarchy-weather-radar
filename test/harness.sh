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
# A test with something of its own to stop, a listener say, puts it in
# `on_exit`.
on_exit=""
harness_exit() {
  [[ -n $on_exit ]] && eval "$on_exit"
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
  if [[ ${1:-} == --basemap ]]; then
    mkdir -p "$work/plugin/data"
    cp "$plugin/data/basemap.bin" "$work/plugin/data/"
  fi
}

# Runs `$work/plugin/probe.qml` under Quickshell, offline and offscreen, for at
# most $1 seconds, with any further arguments passed to `env` (HOME in
# particular, which every caller decides). What the probe reports as
# "PROBE key=value" lines is read back with `value`; the whole output is in
# `$out` for diagnostics. XDG's cache and state variables are always unset, so
# nothing the machine running the test has set leaks into it.
run_qs() {
  local seconds=$1; shift
  out=$(cd "$work" && env -u XDG_CACHE_HOME -u XDG_STATE_HOME "$@" PATH="$work/bin:$PATH" \
        QT_QPA_PLATFORM=offscreen XDG_RUNTIME_DIR="$work/runtime" \
        timeout "$seconds" qs -p "$work/plugin/probe.qml" 2>&1)
  probe=$(printf '%s\n' "$out" | sed -n 's/.*PROBE //p')
}

value() { printf '%s\n' "$probe" | sed -n "s/^$1=//p" | tail -1; }
