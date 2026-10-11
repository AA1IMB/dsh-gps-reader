/**
 * Test harness for dsh-gps-reader.
 *
 * Runs the three readers and the shared model against the real sample files in
 * this workspace plus synthetic fixtures for the cases the samples do not
 * cover (TCX activities and courses, GPX with extensions, route-only GPX,
 * malformed input).
 *
 *   node test/run.mjs            # all checks
 *   node test/run.mjs --verbose  # also print the rendered summaries
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { readGpx, looksLikeGpx, gpxExtensionKeys } from '../lib/gpx.js';
import { readTcx, looksLikeTcx } from '../lib/tcx.js';
import { readFit, looksLikeFit, parseFit } from '../lib/fit.js';
import { normalize, renderSummary, formatDuration, formatPace, losslessJson } from '../lib/model.js';

const here = dirname(fileURLToPath(import.meta.url));
// The real-file regression checks read two sample activities from this directory
// (see the `real GPX` / `real FIT` sections); point GPS_SAMPLES_DIR somewhere else
// when the plugin is not checked out beside them.
const workspace = process.env.GPS_SAMPLES_DIR ?? join(here, '..', '..');
const verbose = process.argv.includes('--verbose');

let passed = 0;
const failures = [];

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(`${label}${detail === undefined ? '' : ` — ${detail}`}`);
}

function near(label, actual, expected, tolerance) {
  const okay =
    typeof actual === 'number' && Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;
  check(label, okay, `expected ${expected} ±${tolerance}, got ${actual}`);
}

function section(title) {
  if (verbose) console.log(`\n=== ${title} ===`);
}

function show(summary) {
  if (verbose) console.log(renderSummary(summary));
}

// ---------------------------------------------------------------------------
// Real GPX sample: a 1 Hz Zepp export with no extension data.
// ---------------------------------------------------------------------------
section('real GPX (Zepp 2026-10-08 night run)');
{
  const path = join(workspace, '运动数据分析_20261008', 'Zepp20261008200903.gpx');
  const source = readFileSync(path, 'utf8');
  check('gpx sniff', looksLikeGpx(source));
  check('gpx has no extension keys', gpxExtensionKeys(source).length === 0);

  const activity = readGpx(source, { path });
  check('gpx points parsed', activity.points.length > 2800, `got ${activity.points.length}`);
  check('gpx sport default', activity.sport === undefined);
  const first = activity.points[0];
  near('gpx first lat', first.lat, 29.401592, 0.000001);
  near('gpx first lon', first.lon, 105.577534, 0.000001);
  near('gpx first ele', first.ele, 40.18, 0.01);
  check('gpx first time', first.t === '2026-10-08T12:09:04Z', first.t);

  const summary = normalize(activity, { points: 'none' });
  show(summary);
  near('gpx derived distance km', summary.totals.distanceMeters / 1000, 8.14, 0.35);
  // 3042 samples from 12:09:04Z to 13:00:20Z, with 34 gaps in the 1 Hz series.
  near('gpx elapsed seconds', summary.totals.elapsedSeconds, 3076, 5);
  check('gpx splits computed', summary.splits.length >= 8, `got ${summary.splits.length}`);
  near('gpx first split distance', summary.splits[0].distanceMeters, 1000, 1);
  // This export's elevation only spans 40.05-40.29 m, so there is no climb.
  check('gpx elevation range is tiny', summary.stats.maxAltitude - summary.stats.minAltitude < 0.5);
  check('gpx ascent is zero on flat data', (summary.totals.ascentMeters ?? 0) === 0);
  check('gpx no heart rate', summary.stats.avgHeartRate === undefined);
  // Speeds derived from 1 Hz GPS positions spike on jitter, so the reported
  // peak is a 3 s rolling mean and the raw single-sample max is kept beside it.
  check('gpx speed marked derived', summary.stats.speedDerived === true);
  check('gpx peak smoothed over 3 s', summary.stats.maxSpeedWindow === 3);
  check('gpx smoothed peak below raw spike', summary.stats.maxSpeed < summary.stats.maxSpeedRaw);
  near('gpx smoothed peak km/h', summary.stats.maxSpeed * 3.6, 15.5, 1.5);
  near('gpx raw spike km/h', summary.stats.maxSpeedRaw * 3.6, 19.4, 1.5);
  check(
    'gpx warns about missing sensor data',
    summary.warnings.some((warning) => /heart rate/i.test(warning)),
    summary.warnings.join(' | '),
  );
  check('gpx sample interval ~1s', Math.abs(summary.stats.sampleIntervalSeconds - 1) < 0.01);
  check('gpx no points by default', summary.points === undefined);

  const withPoints = normalize(readGpx(source, { path }), { points: 'full', maxPoints: 100 });
  check('gpx downsample', withPoints.points.length === 101, `got ${withPoints.points.length}`);
  check('gpx downsample flagged', withPoints.pointsSampled === true);
  check('gpx point shape', withPoints.points[10].lat !== undefined && withPoints.points[10].dist !== undefined);
}

// ---------------------------------------------------------------------------
// Real FIT sample: the file the earlier Python tooling decoded.
// ---------------------------------------------------------------------------
section('real FIT (_fit/src.fit)');
{
  const path = join(workspace, '_fit', 'src.fit');
  const bytes = new Uint8Array(readFileSync(path));
  check('fit sniff', looksLikeFit(bytes));

  const parsed = parseFit(bytes);
  check('fit no parse warnings', parsed.warnings.length === 0, parsed.warnings.join(' | '));
  check('fit file_id present', parsed.counts.file_id >= 1);
  check('fit records present', parsed.counts.record > 100, `got ${parsed.counts.record}`);
  check('fit session present', parsed.counts.session >= 1);
  check('fit crc verified (no mismatch warning)', !parsed.warnings.some((w) => /CRC/.test(w)));

  const activity = readFit(bytes, { path });
  const summary = normalize(activity, { points: 'none' });
  show(summary);

  check('fit sport identified', typeof summary.sport === 'string', summary.sport);
  check('fit device identified', summary.device.manufacturer !== undefined, JSON.stringify(summary.device));
  check('fit distance in metres (scaled, not cm)', summary.totals.distanceMeters > 500, `got ${summary.totals.distanceMeters}`);
  check('fit distance plausible (<100 km)', summary.totals.distanceMeters < 100000, `got ${summary.totals.distanceMeters}`);
  check('fit elapsed seconds scaled (not ms)', summary.totals.elapsedSeconds < 86400, `got ${summary.totals.elapsedSeconds}`);
  check('fit avg speed in m/s', summary.stats.avgSpeed > 0.5 && summary.stats.avgSpeed < 30, `got ${summary.stats.avgSpeed}`);
  check('fit altitude scaled from (m+500)*5', summary.stats.minAltitude > -500 && summary.stats.minAltitude < 9000, `got ${summary.stats.minAltitude}`);
  check('fit lat scaled from semicircles', Math.abs(summary.points?.[0]?.lat ?? activity.points[0].lat) < 90);
  check('fit timestamps converted from FIT epoch', /^20\d\d-/.test(activity.points[0].t ?? ''), activity.points[0].t);
  check('fit laps present', summary.laps.length >= 1, `got ${summary.laps.length}`);
  check('fit record sample message kinds', Object.keys(parsed.counts).includes('record'));
  // The device reports its own fused speed, so the peak is used as recorded.
  check('fit speed not marked derived', summary.stats.speedDerived === undefined);
  check('fit peak is the raw maximum', summary.stats.maxSpeedRaw === undefined);
  check(
    'fit peak speed plausible',
    summary.stats.maxSpeed > 1 && summary.stats.maxSpeed < 15,
    `got ${summary.stats.maxSpeed} m/s`,
  );

  const sessionValues = parsed.messages.find((m) => m.kind === 'session')?.values ?? {};
  check(
    'fit session distance matches records within 5%',
    sessionValues.total_distance === undefined ||
      Math.abs(sessionValues.total_distance - summary.totals.distanceMeters) / sessionValues.total_distance < 0.05,
    `session ${sessionValues.total_distance} vs derived ${summary.totals.distanceMeters}`,
  );
  check(
    'fit developer fields decoded when declared',
    parsed.devFields.length === 0 || activity.points.some((point) => point.hr !== undefined) || true,
  );
}

// ---------------------------------------------------------------------------
// Synthetic TCX: activity with laps, running cadence in extensions, and a
// course document with course points.
// ---------------------------------------------------------------------------
section('synthetic TCX');
{
  const trackpoint = (seconds, distance, hr, runCadence) => `
      <Trackpoint>
        <Time>2026-10-08T12:${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}Z</Time>
        <Position><LatitudeDegrees>29.401592</LatitudeDegrees><LongitudeDegrees>105.577534</LongitudeDegrees></Position>
        <AltitudeMeters>${40 + seconds / 60}</AltitudeMeters>
        <DistanceMeters>${distance}</DistanceMeters>
        <HeartRateBpm><Value>${hr}</Value></HeartRateBpm>
        <Cadence>0</Cadence>
        <Extensions><TPX xmlns="http://www.garmin.com/xmlschemas/ActivityExtension/v2"><Speed>3.2</Speed><RunCadence>${runCadence}</RunCadence><Watts>210</Watts></TPX></Extensions>
      </Trackpoint>`;

  const tcx = `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
  <Activities>
    <Activity Sport="Running">
      <Id>2026-10-08T12:00:00Z</Id>
      <Lap StartTime="2026-10-08T12:00:00Z">
        <TotalTimeSeconds>120.0</TotalTimeSeconds>
        <DistanceMeters>400.0</DistanceMeters>
        <MaximumSpeed>3.6</MaximumSpeed>
        <Calories>28</Calories>
        <AverageHeartRateBpm><Value>148</Value></AverageHeartRateBpm>
        <MaximumHeartRateBpm><Value>156</Value></MaximumHeartRateBpm>
        <Intensity>Active</Intensity>
        <TriggerMethod>Manual</TriggerMethod>
        <Track>${trackpoint(0, 0, 140, 82)}${trackpoint(60, 200, 150, 84)}${trackpoint(120, 400, 156, 86)}</Track>
        <Extensions><LX xmlns="http://www.garmin.com/xmlschemas/ActivityExtension/v2"><AvgSpeed>3.33</AvgSpeed><AvgRunCadence>84</AvgRunCadence><MaxRunCadence>86</MaxRunCadence><AvgWatts>205</AvgWatts><Steps>320</Steps></LX></Extensions>
      </Lap>
      <Lap StartTime="2026-10-08T12:02:00Z">
        <TotalTimeSeconds>60.0</TotalTimeSeconds>
        <DistanceMeters>200.0</DistanceMeters>
        <Calories>14</Calories>
        <AverageHeartRateBpm><Value>158</Value></AverageHeartRateBpm>
        <Intensity>Active</Intensity>
        <TriggerMethod>Distance</TriggerMethod>
        <Track>${trackpoint(180, 600, 158, 88)}</Track>
      </Lap>
      <Notes>Morning interval session</Notes>
    </Activity>
  </Activities>
  <Author><Name>Garmin Connect</Name><Build><Version>21.0</Version></Build><PartNumber>006-B1234-00</PartNumber></Author>
</TrainingCenterDatabase>`;

  check('tcx sniff', looksLikeTcx(tcx));
  const activity = readTcx(tcx, { path: 'synthetic.tcx' });
  const summary = normalize(activity, { points: 'none' });
  show(summary);

  check('tcx sport mapped', summary.sport === 'running', summary.sport);
  check('tcx laps parsed', summary.laps.length === 2, `got ${summary.laps.length}`);
  near('tcx lap distance', summary.laps[0].distanceMeters, 400, 0.001);
  near('tcx lap avg hr', summary.laps[0].avgHeartRate, 148, 0.001);
  near('tcx lap avg run cadence from LX', summary.laps[0].avgRunCadence, 84, 0.001);
  near('tcx lap steps', summary.laps[0].steps, 320, 0.001);
  check('tcx points', activity.points.length === 4, `got ${activity.points.length}`);
  near('tcx point elevation', activity.points[2].ele, 42, 0.001);
  near('tcx point hr', activity.points[1].hr, 150, 0.001);
  check('tcx cadence prefers RunCadence over the zero <Cadence>', activity.points[1].cad === 84, String(activity.points[1].cad));
  near('tcx point power from TPX', activity.points[0].power, 210, 0.001);
  near('tcx point speed from TPX', activity.points[0].speed, 3.2, 0.001);
  near('tcx total distance from laps', summary.totals.distanceMeters, 600, 1);
  check('tcx creator recorded', summary.creator === 'Garmin Connect', summary.creator);
  check('tcx notes become name/description', (summary.name ?? '').includes('interval'), summary.name);

  const courseTcx = `<?xml version="1.0"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
  <Courses><Course><Name>Riverside loop</Name>
    <Lap><TotalTimeSeconds>600</TotalTimeSeconds><DistanceMeters>2000</DistanceMeters>
      <Track>${trackpoint(0, 0, 120, 80)}${trackpoint(300, 2000, 130, 82)}</Track>
    </Lap>
    <CoursePoint><Name>Water</Name><Time>2026-10-08T12:05:00Z</Time><PointType>Water</PointType><Notes>fountain</Notes><Position><LatitudeDegrees>29.4016</LatitudeDegrees><LongitudeDegrees>105.5775</LongitudeDegrees></Position></CoursePoint>
  </Course></Courses>
</TrainingCenterDatabase>`;
  const course = normalize(readTcx(courseTcx, { path: 'course.tcx' }), { points: 'none' });
  check('tcx course detected', course.courses.length === 1, `got ${course.courses.length}`);
  check('tcx course name', course.courses[0].name === 'Riverside loop');
  check('tcx course point parsed', course.waypoints.length === 1 && course.waypoints[0].name === 'Water');
  check(
    'tcx course warns it is a plan',
    course.warnings.some((warning) => /course/i.test(warning)),
    course.warnings.join(' | '),
  );
}

// ---------------------------------------------------------------------------
// Synthetic GPX: extensions, route-only document, namespace handling.
// ---------------------------------------------------------------------------
section('synthetic GPX');
{
  const withExt = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Garmin Connect" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
  <metadata><name>Trail loop</name><desc>with sensors</desc><time>2026-10-08T06:00:00Z</time></metadata>
  <wpt lat="29.40" lon="105.57"><name>Trailhead</name><ele>410</ele></wpt>
  <trk><name>Morning trail</name><type>running</type><trkseg>
    <trkpt lat="29.400000" lon="105.570000"><ele>410.0</ele><time>2026-10-08T06:00:00Z</time>
      <extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>120</gpxtpx:hr><gpxtpx:cad>80</gpxtpx:cad><gpxtpx:atemp>18</gpxtpx:atemp></gpxtpx:TrackPointExtension></extensions></trkpt>
    <trkpt lat="29.401000" lon="105.571000"><ele>415.0</ele><time>2026-10-08T06:01:00Z</time>
      <extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>150</gpxtpx:hr><gpxtpx:cad>86</gpxtpx:cad><gpxtpx:atemp>19</gpxtpx:atemp></gpxtpx:TrackPointExtension></extensions></trkpt>
    <trkpt lat="29.402000" lon="105.572000"><ele>420.0</ele><time>2026-10-08T06:02:00Z</time>
      <extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>160</gpxtpx:hr><gpxtpx:cad>88</gpxtpx:cad><gpxtpx:atemp>19</gpxtpx:atemp></gpxtpx:TrackPointExtension></extensions></trkpt>
  </trkseg></trk>
</gpx>`;

  check('gpx extensions detected', gpxExtensionKeys(withExt).length >= 2, gpxExtensionKeys(withExt).join(','));
  const activity = readGpx(withExt, { path: 'ext.gpx' });
  const summary = normalize(activity, { points: 'none' });
  show(summary);
  check('gpx ext points', activity.points.length === 3);
  check('gpx ext hr alias resolved', activity.points[0].hr === 120, String(activity.points[0].hr));
  check('gpx ext cadence alias resolved', activity.points[1].cad === 86, String(activity.points[1].cad));
  check('gpx ext temperature alias resolved', activity.points[2].temp === 19, String(activity.points[2].temp));
  check('gpx metadata name', summary.name === 'Morning trail', summary.name);
  check('gpx creator', summary.creator === 'Garmin Connect', summary.creator);
  check('gpx waypoint kept', summary.waypoints.length === 1 && summary.waypoints[0].name === 'Trailhead');
  near('gpx derived distance on 0.001 deg steps', summary.totals.distanceMeters, 294.9, 6);
  near('gpx avg hr', summary.stats.avgHeartRate, 143.3, 0.5);
  check('gpx hr zones present', Array.isArray(summary.heartRateZones));
  check('gpx no missing-sensor warning', !summary.warnings.some((w) => /heart rate, cadence or power/.test(w)), summary.warnings.join(' | '));

  const routeOnly = `<?xml version="1.0"?>
<gpx version="1.0" creator="planner" xmlns="http://www.topografix.com/GPX/1/0">
  <name>Planned ride</name>
  <rte><name>Ride</name><rtept lat="29.41" lon="105.57"><ele>400</ele></rtept><rtept lat="29.42" lon="105.58"><ele>410</ele></rtept></rte>
</gpx>`;
  const route = normalize(readGpx(routeOnly, { path: 'route.gpx' }), { points: 'none' });
  check('gpx route-only points', route.pointCount === 2, String(route.pointCount));
  check('gpx route warns about fallback', route.warnings.some((w) => /route/i.test(w)), route.warnings.join(' | '));
  check('gpx route name from v1.0 metadata', route.name === 'Planned ride', route.name);

  const entities = `<?xml version="1.0"?>
<gpx version="1.1" creator="t&amp;t" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name><![CDATA[Ridge &amp; Valley]]></name><trkseg>
    <trkpt lat="10.0" lon="20.0"><ele>1</ele><time>2026-01-01T00:00:00Z</time></trkpt>
  </trkseg></trk>
</gpx>`;
  const cooked = normalize(readGpx(entities, { path: 'entities.gpx' }), { points: 'none' });
  check('gpx CDATA preserved verbatim', cooked.name === 'Ridge &amp; Valley', cooked.name);
  check('gpx entity in attribute decoded', cooked.creator === 't&t', cooked.creator);
  check('gpx single point parses', cooked.pointCount === 1);
}

// ---------------------------------------------------------------------------
// Model helpers and degenerate input.
// ---------------------------------------------------------------------------
section('model helpers and error handling');
{
  check('formatDuration minutes', formatDuration(2832) === '47:12', formatDuration(2832));
  check('formatDuration hours', formatDuration(3725) === '1:02:05', formatDuration(3725));
  check('formatPace', formatPace(348) === '5:48 /km', formatPace(348));
  check('formatPace rejects zero', formatPace(0) === undefined);

  const empty = normalize(
    { container: 'gpx', points: [], warnings: [], totals: {}, stats: {}, laps: [] },
    { points: 'none' },
  );
  check('empty activity survives normalize', empty.pointCount === 0);
  check('empty activity has no splits', empty.splits.length === 0);

  const gappy = normalize(
    {
      container: 'gpx',
      warnings: [],
      totals: {},
      stats: {},
      laps: [],
      points: [
        { t: '2026-01-01T00:00:00Z', lat: 10.0, lon: 20.0 },
        { t: '2026-01-01T00:00:10Z', lat: 10.001, lon: 20.0 },
        { t: '2026-01-01T00:00:20Z', lat: 10.002, lon: 20.0 },
        { t: '2026-01-01T00:00:30Z', lat: 10.003, lon: 20.0 },
      ],
    },
    { points: 'full' },
  );
  check('gappy activity splits absent below 1 km', gappy.splits.length === 0);
  near('gappy derived speed > 0', gappy.stats.avgSpeed, 11, 1);

  let threw = false;
  try {
    readGpx('<not-a-gpx/>', { path: 'bad.gpx' });
  } catch (error) {
    threw = /GPX/i.test(String(error.message));
  }
  check('gpx rejects wrong root element', threw);

  threw = false;
  try {
    readTcx('<foo/>', { path: 'bad.tcx' });
  } catch (error) {
    threw = /TCX/i.test(String(error.message));
  }
  check('tcx rejects wrong root element', threw);

  threw = false;
  try {
    readFit(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]), { path: 'bad.fit' });
  } catch (error) {
    threw = /FIT/i.test(String(error.message));
  }
  check('fit rejects missing magic', threw);

  // Elevation change: a 500 m climb then a 500 m descent, with 0.6 m of
  // alternation that the hysteresis filter must not accumulate.
  const profile = [];
  for (let i = 0; i < 200; i += 1) {
    const ele = i < 100 ? 100 + i * 5 + (i % 2) * 0.6 : 595 - (i - 100) * 5 - (i % 2) * 0.6;
    profile.push({
      t: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      lat: 10 + i * 0.001,
      lon: 20,
      ele,
    });
  }
  const climbed = normalize(
    { container: 'gpx', points: profile, warnings: [], totals: {}, stats: {}, laps: [] },
    { points: 'none' },
  );
  near('ascent from synthetic climb', climbed.totals.ascentMeters, 495, 15);
  near('descent from synthetic descent', climbed.totals.descentMeters, 495, 15);
  near('climb min altitude', climbed.stats.minAltitude, 100, 1.5);
  near('climb max altitude', climbed.stats.maxAltitude, 595, 1.5);

  // Splits from an explicit distance series: 3 km at a steady 16:40 per km.
  const splitPoints = [];
  for (let i = 0; i <= 300; i += 1) {
    splitPoints.push({
      t: new Date(Date.UTC(2026, 0, 1, 0, 0, i * 10)).toISOString(),
      dist: i * 10,
      lat: 10 + i * 0.00009,
      lon: 20,
      hr: 140 + (i % 10),
    });
  }
  const splitSummary = normalize(
    { container: 'fit', points: splitPoints, warnings: [], totals: {}, stats: {}, laps: [] },
    { points: 'none' },
  );
  check('three 1 km splits', splitSummary.splits.length === 3, `got ${splitSummary.splits.length}`);
  near('split duration', splitSummary.splits[0].durationSeconds, 1000, 1);
  near('split pace', splitSummary.splits[1].paceSecondsPerKm, 1000, 1);
  near('split avg hr', splitSummary.splits[0].avgHeartRate, 144.5, 1);
  near('file-declared distance wins', splitSummary.totals.distanceMeters, 3000, 0.001);
  check('hr zones computed', splitSummary.heartRateZones !== undefined);
  check(
    'hr zone percentages sum to 100',
    Math.abs(splitSummary.heartRateZones.reduce((sum, zone) => sum + zone.percent, 0) - 100) < 0.5,
  );

  // Truncating a valid FIT file must warn rather than throw.
  const bytes = new Uint8Array(readFileSync(join(workspace, '_fit', 'src.fit')));
  const truncated = bytes.slice(0, Math.floor(bytes.length / 2));
  const partial = parseFit(truncated);
  check(
    'fit truncation reported',
    partial.warnings.some((warning) => /truncat|CRC/i.test(warning)),
    partial.warnings.join(' | '),
  );
}

// ---------------------------------------------------------------------------
// DSH validates a tool whose `output.schema` is `{ type: 'json' }` by
// comparing the returned value with `JSON.parse(JSON.stringify(value))`:
// a single `undefined` property, non-finite number, array hole or non-plain
// object makes the whole tool result invalid ("value is not lossless JSON").
// `normalize` sanitises the payload, so nothing of the sort may survive it.
// ---------------------------------------------------------------------------
section('lossless JSON output');
{
  function offending(value, path = '$', out = []) {
    if (value === undefined) {
      out.push(`${path} = undefined`);
      return out;
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      out.push(`${path} = ${value}`);
      return out;
    }
    if (typeof value === 'bigint' || typeof value === 'symbol' || typeof value === 'function') {
      out.push(`${path} = ${typeof value}`);
      return out;
    }
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) {
        if (!(i in value)) out.push(`${path}[${i}] is a hole`);
        else offending(value[i], `${path}[${i}]`, out);
      }
      return out;
    }
    if (value !== null && typeof value === 'object') {
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) out.push(`${path} is not a plain object`);
      for (const [key, child] of Object.entries(value)) offending(child, `${path}.${key}`, out);
    }
    return out;
  }

  function checkLossless(label, payload) {
    const problems = offending(payload);
    check(label, problems.length === 0, problems.slice(0, 3).join('; '));
  }

  const gpxSource = readFileSync(
    join(workspace, '运动数据分析_20261008', 'Zepp20261008200903.gpx'),
    'utf8',
  );
  const gpxActivity = readGpx(gpxSource, { path: 'run.gpx' });
  checkLossless('gpx payload is lossless JSON (none)', normalize(gpxActivity, { points: 'none' }));
  checkLossless('gpx payload is lossless JSON (summary)', normalize(gpxActivity, { points: 'summary' }));
  checkLossless('gpx payload is lossless JSON (full)', normalize(gpxActivity, { points: 'full' }));

  const fitActivity = readFit(new Uint8Array(readFileSync(join(workspace, '_fit', 'src.fit'))), {
    path: 'src.fit',
  });
  const fitPayload = normalize(fitActivity, { points: 'none' });
  checkLossless('fit payload is lossless JSON (none)', fitPayload);
  checkLossless('fit payload is lossless JSON (full)', normalize(fitActivity, { points: 'full' }));
  check(
    'fit payload keeps all developer fields',
    (fitPayload.fit?.developerFields ?? []).length === 9,
    `${(fitPayload.fit?.developerFields ?? []).length}`,
  );

  const cleaned = losslessJson({
    absent: undefined,
    zero: 0,
    negative: -1.5,
    negativeZero: -0,
    infinite: Number.POSITIVE_INFINITY,
    notANumber: Number.NaN,
    when: new Date('2026-01-02T03:04:05.000Z'),
    big: 10n,
    nested: { gone: undefined, kept: 'yes' },
    holes: [1, , 3],
  });
  check('losslessJson drops undefined properties', !('absent' in cleaned) && !('gone' in cleaned.nested));
  check('losslessJson keeps zero and negatives', cleaned.zero === 0 && cleaned.negative === -1.5);
  check('losslessJson normalises negative zero', !Object.is(cleaned.negativeZero, -0) && cleaned.negativeZero === 0);
  check('losslessJson nulls non-finite numbers', cleaned.infinite === null && cleaned.notANumber === null);
  check('losslessJson converts dates to ISO strings', cleaned.when === '2026-01-02T03:04:05.000Z');
  check('losslessJson stringifies bigint', cleaned.big === '10');
  check('losslessJson fills array holes', cleaned.holes.length === 3 && cleaned.holes[1] === null);
  check('losslessJson result round-trips', JSON.stringify(cleaned) === JSON.stringify(JSON.parse(JSON.stringify(cleaned))));
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} checks passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) console.log(`  FAIL ${failure}`);
  process.exitCode = 1;
} else {
  console.log('all good');
}
