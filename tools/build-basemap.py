#!/usr/bin/env python3
"""Build data/basemap.bin from Natural Earth.

The plugin draws its own basemap instead of fetching raster tiles. The world's
coastlines do not change, so shipping them costs a few megabytes once instead
of a request per tile forever — and, more to the point, it cannot be taken
away: a keyless tile endpoint is a policy, not a property, and the one this
plugin used started stamping "API KEY REQUIRED" across every tile in August
2026, on a Wednesday, for every installation at once.

Raster tiles could not be shipped: the world from z0 to z9 is 349,525 tiles,
several gigabytes. Vector geometry for the same area is under three megabytes,
because a coastline is a list of points rather than a picture of one.

Run by hand when the source data or the layer selection changes; the output is
committed. Sources are cached in tools/.cache, which is not.

    python3 tools/build-basemap.py

Natural Earth is public domain. Credit is given in the panel anyway.
"""

import json
import math
import os
import struct
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CACHE = os.path.join(HERE, ".cache")
OUTPUT = os.path.join(ROOT, "data", "basemap.bin")

SOURCE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson"

MAGIC = b"OWRB"
FORMAT_VERSION = 1

# Coordinates are stored as integers in units of 1/1000 of a degree — 111 m of
# latitude, and less of longitude away from the equator. At the deepest zoom
# the map reaches, one pixel covers about 300 m, so the quantisation is finer
# than anything that can be drawn.
QUANTUM = 1000

LINE, POLYGON, POINTS = 0, 1, 2

# Simplification tolerance in degrees, per layer.
#
# 0.002 degrees is roughly 220 m, which is under a pixel at the deepest zoom
# for the layers whose shape is read closely — a coastline, a border, the edge
# of a city. Rivers, lakes and state lines carry a looser tolerance: they are
# read as context rather than traced, and they are the layers whose point
# counts would otherwise dominate the file.
LAYERS = [
    # name        source file                                   kind      tol     zooms
    ("land-lo",   "ne_50m_land",                                POLYGON,  0.050,  (3, 5)),
    ("land",      "ne_10m_land",                                POLYGON,  0.002,  (6, 9)),
    ("lakes",     "ne_10m_lakes",                               POLYGON,  0.004,  (5, 9)),
    ("urban",     "ne_10m_urban_areas",                         POLYGON,  0.002,  (7, 9)),
    ("rivers",    "ne_10m_rivers_lake_centerlines",             LINE,     0.004,  (6, 9)),
    ("admin1",    "ne_10m_admin_1_states_provinces_lines",      LINE,     0.005,  (5, 9)),
    ("admin0",    "ne_10m_admin_0_boundary_lines_land",         LINE,     0.002,  (3, 9)),
]

PLACES_SOURCE = "ne_10m_populated_places_simple"


# ---------------------------------------------------------------------------
# Sources
# ---------------------------------------------------------------------------

def fetch(name):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, name + ".geojson")
    if not os.path.exists(path):
        url = f"{SOURCE}/{name}.geojson"
        sys.stderr.write(f"  downloading {name}\n")
        with urllib.request.urlopen(url, timeout=180) as response:
            data = response.read()
        with open(path, "wb") as handle:
            handle.write(data)
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


# ---------------------------------------------------------------------------
# Geometry
# ---------------------------------------------------------------------------

def features_of(geometry):
    """Split a geometry into drawable features, each a list of rings.

    One feature per island and one per line, rather than one per GeoJSON
    record: the renderer culls by a feature's bounding box, and a MultiPolygon
    holding every landmass on earth has a bounding box of the whole world,
    which culls nothing. A polygon keeps its holes in the same feature, so the
    even-odd fill still cuts a lake out of the island it sits in.
    """
    if not geometry:
        return []
    shape, coordinates = geometry["type"], geometry["coordinates"]
    if shape == "LineString":
        return [[coordinates]]
    if shape == "MultiLineString":
        return [[line] for line in coordinates]
    if shape == "Polygon":
        return [coordinates]
    if shape == "MultiPolygon":
        return list(coordinates)
    return []


def simplify(points, tolerance):
    """Douglas-Peucker, iterative so a long coastline cannot blow the stack."""
    if len(points) < 3 or tolerance <= 0:
        return points

    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    limit = tolerance * tolerance

    while stack:
        first, last = stack.pop()
        if last - first < 2:
            continue
        ax, ay = points[first]
        bx, by = points[last]
        dx, dy = bx - ax, by - ay
        span = dx * dx + dy * dy

        worst, index = -1.0, -1
        for i in range(first + 1, last):
            px, py = points[i]
            if span == 0:
                distance = (px - ax) ** 2 + (py - ay) ** 2
            else:
                t = ((px - ax) * dx + (py - ay) * dy) / span
                t = 0.0 if t < 0 else (1.0 if t > 1 else t)
                distance = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2
            if distance > worst:
                worst, index = distance, i

        if worst > limit:
            keep[index] = True
            stack.append((first, index))
            stack.append((index, last))

    return [point for point, kept in zip(points, keep) if kept]


def quantise(points):
    """Round onto the storage grid, dropping points that land on the previous one."""
    out = []
    for lon, lat in points:
        x = int(round(lon * QUANTUM))
        y = int(round(lat * QUANTUM))
        if out and out[-1] == (x, y):
            continue
        out.append((x, y))
    return out


# ---------------------------------------------------------------------------
# Encoding
# ---------------------------------------------------------------------------

def varint(value):
    """LEB128. Callers zigzag first when the value can be negative."""
    if value < 0:
        raise ValueError("varint is unsigned; zigzag first")
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def zigzag(value):
    return (value << 1) ^ (value >> 63) if value < 0 else value << 1


def signed(value):
    return varint(zigzag(value))


def string(text):
    encoded = text.encode("utf-8")
    return varint(len(encoded)) + encoded


def encode_rings(rings):
    """A feature: a count of rings, then each ring's points as deltas."""
    out = bytearray(varint(len(rings)))
    for ring in rings:
        out += varint(len(ring))
        previous_x = previous_y = 0
        for x, y in ring:
            out += signed(x - previous_x)
            out += signed(y - previous_y)
            previous_x, previous_y = x, y
    return bytes(out)


# ---------------------------------------------------------------------------
# Layers
# ---------------------------------------------------------------------------

def build_geometry_layer(name, source, kind, tolerance, zooms):
    collection = fetch(source)
    features = []
    points_in = points_out = 0

    for record in collection["features"]:
        for raw_rings in features_of(record.get("geometry")):
            rings = []
            for ring in raw_rings:
                raw = [(point[0], point[1]) for point in ring]
                points_in += len(raw)
                reduced = quantise(simplify(raw, tolerance))
                # A polygon needs three corners; a line needs two ends.
                if len(reduced) < (3 if kind == POLYGON else 2):
                    continue
                points_out += len(reduced)
                rings.append(reduced)
            if rings:
                features.append(rings)

    body = bytearray()
    body += string(name)
    body += bytes([kind, zooms[0], zooms[1]])
    body += varint(len(features))
    for rings in features:
        body += encode_rings(rings)

    return bytes(body), len(features), points_in, points_out


def build_places_layer(zooms):
    collection = fetch(PLACES_SOURCE)
    places = []

    for feature in collection["features"]:
        properties = feature["properties"]
        name = properties.get("name")
        coordinates = feature.get("geometry", {}).get("coordinates")
        if not name or not coordinates:
            continue

        # Natural Earth's own guidance on when a place is worth drawing. It is
        # a float in the source and a per-place zoom threshold here, so the map
        # can thin its labels the way the cartographers intended rather than by
        # population, which reads badly in sparsely populated regions.
        try:
            first_zoom = int(math.ceil(float(properties.get("min_zoom", 10))))
        except (TypeError, ValueError):
            first_zoom = 10

        places.append((
            int(round(coordinates[0] * QUANTUM)),
            int(round(coordinates[1] * QUANTUM)),
            max(0, min(255, first_zoom)),
            str(name),
        ))

    # Sorted by longitude so the delta encoding has something to compress, and
    # so a viewport query can stop scanning once it is past the east edge.
    places.sort(key=lambda place: place[0])

    body = bytearray()
    body += string("places")
    body += bytes([POINTS, zooms[0], zooms[1]])
    body += varint(len(places))

    previous_x = previous_y = 0
    for x, y, first_zoom, name in places:
        body += signed(x - previous_x)
        body += signed(y - previous_y)
        body += bytes([first_zoom])
        body += string(name)
        previous_x, previous_y = x, y

    return bytes(body), len(places)


# ---------------------------------------------------------------------------

def main():
    layers = []
    report = []

    for name, source, kind, tolerance, zooms in LAYERS:
        sys.stderr.write(f"building {name}\n")
        body, count, points_in, points_out = build_geometry_layer(
            name, source, kind, tolerance, zooms)
        layers.append(body)
        report.append((name, count, points_in, points_out, len(body)))

    sys.stderr.write("building places\n")
    body, count = build_places_layer((3, 9))
    layers.append(body)
    report.append(("places", count, count, count, len(body)))

    header = bytearray(MAGIC)
    header += bytes([FORMAT_VERSION])
    header += varint(QUANTUM)
    header += varint(len(layers))

    os.makedirs(os.path.dirname(OUTPUT), exist_ok=True)
    with open(OUTPUT, "wb") as handle:
        handle.write(bytes(header))
        for body in layers:
            handle.write(body)

    total = os.path.getsize(OUTPUT)
    sys.stderr.write("\n%-10s %8s %10s %10s %9s\n"
                     % ("layer", "features", "points in", "points out", "bytes"))
    for name, count, points_in, points_out, size in report:
        sys.stderr.write("%-10s %8d %10d %10d %9d\n"
                         % (name, count, points_in, points_out, size))
    sys.stderr.write("%-10s %8s %10s %10s %9d  (%.2f MB)\n"
                     % ("total", "", "", "", total, total / 1024 / 1024))


if __name__ == "__main__":
    main()
