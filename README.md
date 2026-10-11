# dsh-gps-reader

A DSH plugin that lets the agent read **GPX**, **TCX** and **FIT** activity files directly.

It registers a single tool, `activity_read`, which turns an activity file into a compact
summary (or a full JSON payload on request) without any external binary, Python runtime or
network call. GPX and TCX are parsed with a built-in XML reader; FIT is decoded from the
binary with a full profile table (including developer fields used by Zepp / Amazfit /
COROS devices).

## Install

The plugin is a normal DSH bundle package. Copy the directory somewhere inside the
profile and insert one row into that profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: tool-gps
      name: './node_modules/dsh-gps-reader/lib/index.js'
```

The profile watches `cordis.patch.yml`, so a **newly inserted** row activates by itself
within a moment — no restart, and no `disabled: false` override is needed. A relative or
absolute `name` is resolved against the patch file's directory by the loader; the row
above uses the profile's `node_modules`, but any location inside the profile works (the
desktop profile it was developed against keeps it at
`./local-plugins/gps-reader/lib/index.js`).

The package must be a **real directory**, not a symlink or junction: Node resolves a
linked package to its real path and then walks up from there, where the
`@deepseek-ai/dsh-*` peer packages do not exist.

The plugin has no runtime dependencies. Its peers are resolved from the profile's shared
package store (`<user>/.dsh/profiles/node_modules`).

### Editing an installed plugin

A running host keeps executing the module it already imported. The loader imports by URL
with no cache-busting query, so Node's ESM cache answers every later import of the same
file, and changing the `name` of an existing row is inert as well — a module placed at a
freshly named path is never evaluated. To load edited code, insert a **new** entry whose
path the host has not imported yet, or restart DSH; reload the tool catalogue afterwards,
because a turn's tool list is snapshotted when the turn starts.

### Keep the peer range loose

DSH refuses to load a profile row whose manifest declares an unmet `@deepseek-ai/dsh-*`
peer dependency, and it reports that **only on stderr** — under a GUI host the message is
invisible, the row simply keeps `enabled: false` with no fiber and the plugin manager
answers `"application": "overridden"`. `@deepseek-ai/dsh-tools` is therefore declared as
`>=0.1.5-rc.1 <0.3.0` so it satisfies both the 0.1.5 and 0.2.0 runtimes. Pinning it to
`^0.1.5-rc.1` — a caret range that stops below `0.2.0` — silently disables the plugin on
DSH 0.2.0-rc.2. Only `@deepseek-ai/dsh` and `@deepseek-ai/dsh-*` peers are validated, so
`@deepseek-ai/cordis` and `@deepseek-ai/schemastery` are never inspected.

## Configuration

| key | default | meaning |
| --- | --- | --- |
| `maxBytes` | `67108864` (64 MiB) | largest file the tool will read |
| `maxPoints` | `500` | default cap when sampling a point series |
| `splits` | `true` | compute per-kilometre splits by default |

```yaml
- id: tool-gps
  config:
    maxBytes: 33554432
    maxPoints: 1000
```

## Tool: `activity_read`

| parameter | type | default | meaning |
| --- | --- | --- | --- |
| `path` | string (required) | – | file to read, relative paths resolve against the session cwd |
| `format` | `auto` \| `gpx` \| `tcx` \| `fit` | `auto` | override format detection |
| `points` | `none` \| `summary` \| `full` | `none` | include no series, a ~60-bucket series, or the whole series |
| `maxPoints` | number | config | cap for `points: full` (clamped to 20000) |
| `splits` | boolean | config | include per-kilometre splits |
| `json` | boolean | `false` | render the entire result as indented JSON instead of text |

Format detection looks at the content first (FIT magic bytes, then the XML root element)
and only falls back to the file extension. If an explicit `format` disagrees with the
detected one, the file wins and the mismatch is reported as a warning.

### Text output

```
FIT · D:\runs\morning.fit
Amazfit Cheetah Pro run [running]
start 2026-10-08T12:09:03.000Z · end 2026-10-08T13:00:21.000Z
elapsed 51:18 · moving 51:06
distance 8.14 km · avg pace 6:18 /km · avg speed 9.53 km/h · max 12.78 km/h
elevation +45 m · -50 m · altitude 301-306 m
HR avg 157 / max 179 bpm · cadence avg 90 rpm · power avg 231 W · 567 kcal
3079 points · 3067 with GPS · ~1.0 s sampling · 3041 HR samples
HR zones: Z1 recovery 0:09 (0.3%) · Z2 easy 0:32 (1.1%) · …
splits:
  # 1   1.00 km     6:36   6:36 /km  143 bpm  89 rpm  226 W
  …
```

Lines are omitted when the data is absent, so a GPS-only GPX produces a much shorter
summary and records a warning such as `no heart rate, cadence or power in <extensions>`.

### JSON payload

`json: true` returns the full structured result:

```
{
  ok, tool, format, file, sizeBytes,
  text,                       // the same summary as above
  payload: {
    container, path, name, description, creator, version,
    startTime, endTime, sport, subSport,
    pointCount, pointsSampled, sampleIntervalSeconds,
    totals: { distanceMeters, elapsedSeconds, movingSeconds, ascentMeters, descentMeters, calories },
    stats:  { avgHeartRate, maxHeartRate, avgCadence, avgPower, minAltitude, maxAltitude, … },
    laps, splits, heartRateZones, events, waypoints, routes, courses, activities,
    device, extras, warnings,
    points: [ { t, lat, lon, ele, hr, cad, speed, power, temp, dist, grad, … } ]
  }
}
```

`payload.points` is present only when `points` is not `none`.

## What is read

**GPX** — `<metadata>` (name/description/keywords/time/author/link/bounds), waypoints,
routes, and every `<trkseg>` point (`lat`, `lon`, `ele`, `time`). Extensions are matched
by local name after folding to lower-case alphanumerics, so `gpxtpx:hr`, `gpxdata:hr`
and a bare `<power>` all resolve — heart rate, cadence, power, temperature, speed,
distance, grade, stride length, vertical oscillation and ground contact time. GPX 1.0
and GPX 1.1 are both supported; route-only documents fall back to `<rte>` points.

**TCX** — `<Activities><Activity>` with per-lap totals and per-trackpoint data. Cadence
prefers `<Extensions><TPX><RunCadence>` over `<Cadence>`, because running producers leave
`<Cadence>` at zero. Garmin `<LX>` lap extensions (avg speed, run cadence, watts, steps)
are read. Courses (`<Courses><Course>`, including `<CoursePoint>`) are recognised and
reported as courses rather than activities.

**FIT** — the full binary protocol: chained file sections, definition and data messages,
compressed-timestamp headers, multiple local message types, endianness, invalid-value
sentinels, CRC validation, and developer fields (`developer_data_id` +
`field_description`) as used by Zepp / Amazfit / COROS. Official scale and offset
conversions from the FIT profile are applied to both standard and developer fields, so
values come out in SI units (metres, m/s, °C, degrees) rather than raw integers.

Files are also normalised uniformly: points are sorted by time, cumulative distance is
computed with a haversine formula when the file does not provide it, GPS spikes are
ignored, elevation gain/loss uses a hysteresis threshold, moving time is derived from a
speed threshold, and per-kilometre splits and heart-rate zones are calculated.

When the file carries no speed of its own, speed is derived from consecutive positions.
A single 1 Hz position error of 5 m reads as 18 km/h, so in that case the reported peak
is the maximum of a 3-second rolling mean (printed as `max 15.48 km/h (3 s mean)`) and
the raw single-sample maximum is kept in `stats.maxSpeedRaw` with
`stats.speedDerived: true`. Files that record their own fused speed (FIT, TCX) report
that value unchanged.

## Limitations

- Wrist-based swim and other non-GPS activities have no coordinates; the summary then
  reports distance only.
- A peak speed derived from GPS positions cannot match the device's fused speed; expect
  the smoothed value to stay a little above what the watch reports. `stats.maxSpeedRaw`
  is available when the unfiltered spike matters.
- `product` ids that are not in the bundled FIT profile table are reported as raw
  numbers (for example the Cheetah Pro reports manufacturer `339`).
- Very large files are read in one buffer, capped by `maxBytes`.
- The XML reader deliberately ignores DTDs and external entities; documents that depend
  on a DTD for entity definitions will not resolve those entities.

## Development

```
node test/run.mjs           # 122 checks
node test/run.mjs --verbose # also print rendered summaries
```

The harness uses the real sample files in the workspace plus synthetic GPX, TCX and FIT
fixtures, and has no dependencies.
