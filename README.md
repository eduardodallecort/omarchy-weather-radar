# Weather Radar for Omarchy

Live weather radar for the [Omarchy](https://omarchy.org) bar. Click the bar
icon for a map centred on your location, scrub through the last two hours of
precipitation, and optionally be told when a storm is on its way.

Works anywhere RainViewer has radar coverage, which is most of the populated
world — no account and no API key.

![The radar panel open on an Omarchy desktop, showing storms over Michigan and Lake Huron with the alert rings drawn around Detroit](screenshots/desktop.webp)

> **Not a life-safety tool.** This plugin is informational. It shows
> best-effort third-party radar with no availability guarantee, and it can be
> late, wrong, or silent. For decisions that matter, use your national weather
> service and civil defence warnings.

## Install

```bash
omarchy plugin add https://github.com/eduardodallecort/omarchy-weather-radar.git --enable
```

The widget lands on the right of the bar. Consider moving it beside the stock
weather widget, which sits in the centre by default:

```bash
omarchy plugin enable eduardodallecort.weather-radar --section center --after omarchy.weather
```

![The Omarchy bar showing the clock, the stock weather widget and the radar scope icon beside it](screenshots/bar.webp)

The icon is a radar scope, which on its own says "radar" rather than "weather";
standing next to a weather widget supplies the rest. `--section` takes `left`,
`center` or `right`, and `--before` works like `--after`. Re-running `enable`
rewrites the widget's entry, so move it before tuning the settings rather than
after.

If that second command reports the plugin is unknown, run it again. Installing
asks the shell to rescan and returns before the shell has finished indexing the
new directory, so a command issued immediately afterwards can arrive first.

### Updating

```bash
omarchy plugin update eduardodallecort.weather-radar
omarchy restart shell
```

The restart is not optional. `omarchy plugin update` fetches the new code and
asks the shell to rescan, but an already-mounted service is not rebuilt from
it — the shell logs that it reloaded the plugin while continuing to run the
version it started with. Until the shell restarts, an update has changed the
files on disk and nothing else.

### Removing it

```bash
omarchy plugin remove eduardodallecort.weather-radar
```

That deletes the plugin and its entry in the bar. It leaves
`~/.local/state/omarchy/settings/weather.json` alone, since that file belongs to
the stock weather widget rather than to this plugin.

### Requirements

Omarchy Quattro, and `curl`, which Omarchy already installs. The base map needs
nothing at all — it ships with the plugin. The plugin calls
`omarchy-weather-location` to store a chosen city and `omarchy-notification-send`
to raise an alert — both ship with Omarchy. Nothing else is installed, and no
configuration outside the widget's own entry is written.

## The map

![The radar panel: storms over Michigan with distance rings around Detroit, a timeline scrubber below the map, then the location, the storm alert switch, and the radius and threshold choices](preview.webp)

| | |
| --- | --- |
| Drag | pan |
| Wheel, `+` / `-` | zoom towards the pointer |
| Play button, `Enter` | play the last two hours |
| `←` / `→` | step one frame |
| Crosshair button, `Home` | recentre on your location |
| `Esc` | close |

The panel opens on your location and on the newest frame, every time. Both are
questions about now: panning and scrubbing are for looking around while you are
there, not for choosing what the panel shows the next time you ask.

While it is open the opposite holds. A new frame list arriving every ten minutes
does not move you: if you have scrubbed back to a particular time, you stay on
that time, at whatever position it has moved to since — or on the oldest frame
still published, once the moment has aged out of the two-hour window.

While it is open the map looks for a new frame every ten minutes, which is about
how often RainViewer publishes one — so the newest frame on screen can be up to
a cycle behind theirs. Once you close it, the map asks for nothing.

### What the colours mean

![Radar over Michigan: blue for light rain grading through yellow and orange to red cores, over coastlines and place names drawn from the base map that ships with the plugin](screenshots/map.webp)

Radar shows **precipitation**, not cloud. A completely overcast sky with no rain
falling reads as an empty map — that is correct, not a fault. Warmer colours
mean heavier precipitation, and the most intense cores usually indicate hail.

Eight palettes are available in the widget settings. NEXRAD Level III is the one
most broadcast meteorologists use.

### The base map

The coastlines, borders, lakes, rivers, city footprints and place names are
**drawn by the plugin from data in the repository**, not fetched from a tile
server. That has three consequences worth knowing about:

- The map works with **no network at all**. Only the radar needs one.
- Nothing about it can be withdrawn or rate-limited. Earlier versions used a
  free tile service that began requiring an API key in August 2026 and stamped
  a watermark across every tile until one was supplied.
- It follows your Omarchy theme. Switch themes and the ground changes with
  everything else, while the radar keeps its own palette — see
  [What the colours mean](#what-the-colours-mean).

The trade is detail. The data is Natural Earth at 1:10 million, so there are no
streets and no municipal boundaries, and at the deepest zoom a coastline is
visibly generalised. City names are Natural Earth's own, which are usually the
local spelling — `København`, `Göteborg` — and occasionally the English one:
`Cologne` rather than `Köln`.

### Zoom

RainViewer's radar tiles stop at zoom level 7, about 1.1 km per pixel. The map
goes to level 9 anyway: past level 7 the ground carries on sharpening while the
radar is scaled up over it, which shows plainly where the radar's data ran out.

It stops at 9 because that is where the ground runs out too. Natural Earth at
1:10 million is drawn for scales down to roughly 1:2 million; magnifying it
further would show a precision it does not have, over radar that was already
being upscaled two levels earlier.

### Where there is no radar

Large parts of the world have no ground radar at all, and there an empty map
means "nothing is known" rather than "nothing is falling". When your location is
outside coverage, the panel says so beside the city name.

### When the map has nothing to draw

An empty radar reads as "it is not raining", so the map says which of the two it
is: `Loading radar…` while the frames are on their way, and `Radar unavailable`
when fetching them failed and there are none.

With frames already in hand it keeps drawing them, with no network at all — the
images are cached by URL, so the last two hours stay on screen and the timeline
underneath says which moment each one is. Opening the panel asks for anything
missing, so reconnecting clears it without a restart.

## Location

Click the city name at the bottom of the panel and type to search.

The picker is the stock weather widget's — same geocoding, same suggestions —
and it writes to the same file, so a city chosen here moves the stock weather
widget too, and one chosen there moves the radar. Both watch the file, so
neither needs a restart.

The location lives in `~/.local/state/omarchy/settings/weather.json`, owned by
`omarchy-weather-location`, which can also be called directly:

```bash
omarchy-weather-location
```

Clearing it returns the weather widget to IP auto-detection.

Pressing Enter on text that matched nothing saves it as a name, which is what
the stock weather widget wants — it resolves names itself. The radar cannot: it
centres on a coordinate and fetches the forecast by coordinate. So a location
saved that way is reported as having no coordinates, beside the city name and
under the STORM ALERTS heading, rather than leaving the map quietly empty.

In a large city, name your neighbourhood rather than the city: São Paulo is some
50 km across and its centre says nothing useful about the far side. The picker
resolves Tatuapé, Vila Mariana, Itaquera and the rest, and the region shown
beside each suggestion separates them from their namesakes elsewhere.

## Alerts

Alerts are **off by default**. Turn them on from the toggle in the panel, or in
the widget settings.

While on, the plugin checks the forecast every ten minutes — the forecast model
does not update any faster, so checking more often would re-fetch bytes that
have not changed. That is roughly 15 MB a month. With alerts off it makes no
background requests at all, and fetches only while the map is open.

Two settings shape what reaches you, and they answer different questions. The
**radius** decides how far ahead to look; the **threshold** decides how bad it
has to be to be worth interrupting you. Both are in the panel once alerts are
on, and in the widget settings either way.

### The threshold: how bad is worth saying

| Threshold | Rain rate | In practice |
| --- | --- | --- |
| Light | 0.5 mm/h | drizzle |
| Moderate | 2.5 mm/h | steady rain |
| Heavy | 7.6 mm/h | downpours and convective cores — the default |
| Severe | 15 mm/h | a deluge, or promoted from Heavy by the rule below |

Rates follow the standard intensity scale, checked against 2144 forecast samples
over the Sahel, the Amazon, the United States, Indonesia and India. Heavy lands
near the 99th percentile of wet slots in that survey: rare enough to mean
something, common enough to fire.

The promotion rule is the one that matters for storms. A slot already at
moderate or above is raised one band when CAPE reaches 2000 J/kg, or 1000 J/kg
alongside gusts of 45 km/h. Rain alone does not make weather severe — rain
arriving into an unstable airmass does, and CAPE measures the energy available
to it.

A severe alert names the figures that put it there, and only those: rain heavy
enough on its own reads "up to 18 mm/h", while ordinary rain into a loaded
airmass reads "CAPE 2400 J/kg". Printing every figure regardless would produce
sentences that argue with themselves, since a mild gust quoted beside the word
severe reads as a contradiction.

A threshold is what keeps the plugin usable. Without one, a two-hour window
fires on every passing shower, which in a wet season is constant noise — and a
plugin switched off in irritation takes the alert that mattered with it.

### The radius: how much warning you want

| Radius | Warning | Trade-off |
| --- | --- | --- |
| 50 km | ~1 h | late, but almost never wrong |
| 100 km | ~2 h | the default |
| 150 km | ~3 h | enough time to act on |
| 200 km | ~4 h | more warning, more false alarms |

The radius draws the rings on the map and sets how far ahead the forecast is
inspected, converted at an assumed 50 km/h. Lead time is not free: a four-hour
forecast is meaningfully less certain than a one-hour one, so a wider radius
buys warning at the cost of crying wolf more often.

The panel offers those four. The widget settings take any value from 25 to
250 km in steps of 25, and one set there appears in the panel alongside the
presets.

### Where it looks

The forecast model runs on a grid roughly 8-10 km across, and a single
coordinate speaks for whichever cell it lands in rather than for the place it
names. Measured against a small town: its centre resolves to a cell 3.8 km away,
and a point 1 km south belongs to the next cell over.

So each check samples five points — the centre and four at 5 km — and reports
the worst. Around that town it covers three model cells instead of one. All
five travel in a single request, so the coverage costs a larger response rather
than more requests.

Five kilometres covers a town without becoming a regional forecast. Below about
8 km the model has no detail to give: rain on one side of a small town and not
the other is a distinction it does not carry. The map is the finer instrument,
at 1.1 km per pixel.

### Being told once

You are not told twice about the same thing. An alert speaks again only if
conditions get *worse* — heavy becoming severe — and re-arms itself when the
outlook drops back under your threshold. A storm parked overhead for three hours
is one notification, not eighteen.

Deliberate acts re-arm it, on the principle that adjusting a control is a
question and deserves an answer rather than ten minutes of silence:

| | |
| --- | --- |
| Open the panel | asks again if the last attempt failed, or if the reading is older than the cycle |
| Middle-click the bar icon | checks now, quietly — you are not re-notified |
| Toggle alerts off and on | re-arms — you are told the current state |
| Change the threshold | re-evaluates the reading already in hand |
| Change the radius | fetches again, since the lead window moved |
| Change the city | a new place has not been reported on yet |

Those are two different questions. Opening the panel refreshes a reading that
has gone stale or was failing; it does not tell you again about weather you have
already been told about. Switching the toggle off and on is what does that.

### What the switch says

The line under the STORM ALERTS heading reports what the watch is actually doing,
because a quiet plugin and a broken one look the same otherwise:

| | |
| --- | --- |
| `off` | the switch is off |
| `no location set` | nothing is stored to check |
| `the saved location has no coordinates` | a name is stored, but nothing to centre or forecast on |
| `starting…` | nothing has come back yet |
| `checking…` | a request is in flight |
| `cannot reach the forecast` | one came back and failed — this is not silence, it is an outage |
| `no forecast for this location` | it answered with nothing usable for these coordinates |
| `nothing expected` | it answered, and there is no weather to report |
| `heavy expected around 21:45` | the outlook, and when |
| `… · not updating` | the reading still stands, but the checks behind it are failing |

A reading already in hand is kept and marked rather than replaced by the error.
Losing it would trade something true and slightly old for nothing at all, and
the reading is what you opened the panel to see.

Opening the panel asks again if the last attempt failed, or if the reading is
older than the quarter hour the forecast is published on — so reconnecting and
reopening is enough, and there is no need to toggle the switch off and on.
Inside that window it asks for nothing, since the answer would be the bytes it
already holds.

### On screen

![Notification reading "Heavy rain approaching — in about 1h, around 23:30 at Mont-Laurier"](screenshots/alert-heavy.webp)

![Notification reading "Moderate rain now — under way since 22:30 at Benton Harbor"](screenshots/alert-moderate.webp)

| Level | Stays | |
| --- | --- | --- |
| Severe, Heavy | until dismissed | the value of an alert lies in the moment you were not looking |
| Moderate, Light | 8 seconds | worth saying, not worth camping on the screen |

A timed toast that fires while you are in the next room is a toast that never
happened, and that is the case an alert exists for. Heavy is also the default
threshold — the level this plugin calls worth interrupting you over — so letting
it expire unseen would contradict its own choice.

That does not make them emergencies: Omarchy only lets a popup through Do Not
Disturb when the sender is CLI-style, and this one names itself, so a silenced
session files them into notification history instead of showing them.

Clicking an alert dismisses it and nothing else. A click on a toast means "I
have seen this" to almost everyone, and spending that gesture on opening a
window answers a question the reader did not ask. Open the map yourself when you
want it.

Every alert carries both a relative and an absolute time — "in about 2h, around
21:15" — because the relative half is what the eye wants on arrival and the
absolute half is what stays true for someone reading it later.

## Data sources

- Radar imagery: [RainViewer](https://www.rainviewer.com) — best-effort, no SLA
- Forecast and geocoding: [Open-Meteo](https://open-meteo.com)
- Base map: [Natural Earth](https://www.naturalearthdata.com/) 1:10m and 1:50m,
  public domain, shipped with the plugin as `data/basemap.bin`

## Roadmap

- Satellite cloud layer (GOES / Himawari via NASA GIBS)
- A denser place-name set for the deepest zoom levels
- Additional radar providers for regions with higher-resolution national
  networks, selectable per user
- Motion-based arrival estimate rather than distance alone

## Development

Symlink a checkout into the plugin directory and the shell picks it up, so the
source can live wherever you keep your projects:

```bash
ln -s ~/path/to/omarchy-weather-radar ~/.config/omarchy/plugins/eduardodallecort.weather-radar
omarchy-shell shell rescanPlugins
omarchy plugin enable eduardodallecort.weather-radar
omarchy plugin validate .
```

**After editing any QML, restart the shell:**

```bash
omarchy restart shell
```

Quickshell's hot reload is deliberately off in Omarchy. A watcher sometimes logs
`Local plugin changed, reloading`, but it cannot be relied on: writing a file
atomically — a temporary plus a rename, which most editors and tools do — breaks
the inotify watch on the original inode, so it fires once and then goes quiet.
`rescanPlugins` re-reads manifests without recompiling QML that is already
loaded. Restarting is the only reliable way to see a change, and an edit that
appears to do nothing is usually an edit that was never loaded.

### Layout

Everything that is a plain function lives in `lib/` and is tested; everything
that needs the shell to exist lives in a `.qml` file and is not.

| File | |
| --- | --- |
| `Service.qml` | headless singleton: frame manifest, forecast polling, alert decisions |
| `Panel.qml` | panel state and lifecycle; composes the pieces below |
| `BarWidget.qml` | the bar pill |
| `ui/RadarMap.qml` | basemap, radar layers, alert rings, pan and zoom |
| `ui/BasemapLayer.qml` | draws the ground, in the running theme's colours |
| `ui/TileLayer.qml` | one raster layer of an XYZ tile map |
| `ui/CoverageProbe.qml` | reads the coverage mask to answer "is there radar here" |
| `ui/Timeline.qml` | play/pause and the frame scrubber |
| `ui/LocationPicker.qml` | the city row and its search results |
| `ui/AlertControls.qml` | the alert switch, radius and threshold |
| `ui/ChoiceSection.qml` | a heading, what it costs, and a row of equal buttons |
| `lib/TileMath.js` | Web Mercator projection, distance and bearing |
| `lib/RadarModel.js` | RainViewer endpoints, parsing, echo analysis, sampling |
| `lib/Alerts.js` | intensity bands, forecast reduction, the latch, and what the panel says |
| `lib/Settings.js` | reading and coercing the widget's settings |
| `lib/Basemap.js` | decodes `data/basemap.bin` and projects it into the viewport |
| `lib/Frames.js` | which radar frame to show, across a list that keeps being replaced |
| `lib/Glyphs.js` | every Nerd Font glyph the plugin draws |
| `tools/build-basemap.py` | builds `data/basemap.bin` from Natural Earth |

A bar widget is instantiated once per monitor, so anything that polls belongs in
the service, which the shell mounts exactly once per plugin.

### Rebuilding the base map

`data/basemap.bin` is generated and committed. Rebuild it only when the layers
or their simplification change:

```bash
python3 tools/build-basemap.py
```

It downloads Natural Earth into `tools/.cache` (about 70 MB, ignored by git),
simplifies each layer, quantises the coordinates onto a grid of a thousandth of
a degree, and writes roughly 2.6 MB. The format is documented at the top of the
generator and decoded by `lib/Basemap.js`; both sides are pinned by tests, so a
change to one without the other fails rather than shipping a map of noise.

### Tests

The files in `lib/` are QML `.pragma library` files, which are plain JavaScript
once the QML-only directives are stripped. `test/load.js` does the stripping and
runs the real file, so the tests exercise what the shell loads rather than a
copy of it. No dependencies, and Node's own runner:

```bash
node --test
```

They cover the projection, the RainViewer and Open-Meteo parsing, the alert
bands and latch, the settings coercion, the frame selection and the glyph
codepoints. Some of them pin bugs that have already been fixed once.

`test/streams.test.js` is a different kind of check: it holds the QML sources to
a written-down inventory of everything that reaches the shell process, and to a
ceiling on each. A plugin runs inside the process that owns the bar, the panels
and the lock screen, so a stream added later without a limit fails the suite
rather than turning up in a review.

QML is checked statically, which needs the shell's modules on the import path:

```bash
qmllint -I /usr/share/omarchy/shell -I . *.qml ui/*.qml
```

`Panel.qml` fails this on the typed function signatures inside its `IpcHandler`,
which Quickshell requires and this `qmllint` cannot parse. The other files are
clean.

## Licence

MIT. See [LICENSE](LICENSE).
