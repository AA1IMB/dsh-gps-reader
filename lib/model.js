/**
 * Shared model: turns the reader-specific intermediate structure into one
 * normalised summary (distance, pace, splits, elevation, heart-rate zones) and
 * renders it as compact text for the model.
 *
 * Everything here is derived from the point series when the file itself does
 * not carry totals, so a bare GPX track (positions and timestamps only) still
 * reports distance, moving time, pace and elevation change.
 */

const EARTH_RADIUS_M = 6371008.8;
const MOVING_SPEED_THRESHOLD = 0.5; // m/s
const ELEVATION_HYSTERESIS_M = 1.0;

const toRadians = (degrees) => (degrees * Math.PI) / 180;

/** Great-circle distance in metres. */
export function haversineMeters(aLat, aLon, bLat, bLon) {
  const dLat = toRadians(bLat - aLat);
  const dLon = toRadians(bLon - aLon);
  const lat1 = toRadians(aLat);
  const lat2 = toRadians(bLat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function formatDuration(seconds) {
  if (seconds === undefined || seconds === null || !Number.isFinite(seconds)) return undefined;
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function formatPace(secondsPerKm) {
  if (secondsPerKm === undefined || !Number.isFinite(secondsPerKm) || secondsPerKm <= 0) {
    return undefined;
  }
  const total = Math.round(secondsPerKm);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')} /km`;
}

function round(value, digits) {
  if (value === undefined || value === null || !Number.isFinite(value)) return undefined;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function mean(values) {
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function maxOrUndefined(values) {
  if (values.length === 0) return undefined;
  let best = values[0];
  for (const value of values) if (value > best) best = value;
  return best;
}

function minOrUndefined(values) {
  if (values.length === 0) return undefined;
  let best = values[0];
  for (const value of values) if (value < best) best = value;
  return best;
}

function minMax(values) {
  return [minOrUndefined(values), maxOrUndefined(values)];
}

/** Median gap between timestamped points, in seconds. */
function sampleInterval(points) {
  const deltas = [];
  for (let i = 1; i < points.length; i += 1) {
    const previous = points[i - 1].tMs;
    const current = points[i].tMs;
    if (previous === undefined || current === undefined) continue;
    const delta = (current - previous) / 1000;
    if (delta > 0 && delta < 3600) deltas.push(delta);
  }
  if (deltas.length === 0) return undefined;
  deltas.sort((a, b) => a - b);
  return deltas[Math.floor(deltas.length / 2)];
}

/**
 * Derive distance, speed, elevation and zone metrics from the point series.
 * Mutates each point with `dist` (cumulative metres) and `tMs` (epoch ms).
 */
function deriveFromPoints(activity) {
  const points = activity.points;
  for (const point of points) {
    if (point.t !== undefined && point.tMs === undefined) {
      const parsed = Date.parse(point.t);
      if (Number.isFinite(parsed)) point.tMs = parsed;
    }
  }

  const hadFileDistance = points.some((point) => point.dist !== undefined);
  let cumulative = 0;
  for (let i = 0; i < points.length; i += 1) {
    const point = points[i];
    if (i > 0) {
      const previous = points[i - 1];
      if (
        point.lat !== undefined &&
        point.lon !== undefined &&
        previous.lat !== undefined &&
        previous.lon !== undefined
      ) {
        const step = haversineMeters(previous.lat, previous.lon, point.lat, point.lon);
        // Ignore implausible jumps (GPS spikes) when the timing is known.
        const seconds =
          point.tMs !== undefined && previous.tMs !== undefined
            ? (point.tMs - previous.tMs) / 1000
            : undefined;
        const plausible = seconds === undefined || seconds <= 0 || step / seconds < 30;
        if (plausible) cumulative += step;
      }
    }
    if (!hadFileDistance) point.dist = round(cumulative, 1);
  }

  // Fill speed where the file omitted it, using the position series.
  const hadFileSpeed = points.some((point) => point.speed !== undefined);
  for (let i = 1; i < points.length; i += 1) {
    const point = points[i];
    const previous = points[i - 1];
    if (point.speed !== undefined) continue;
    if (point.tMs === undefined || previous.tMs === undefined) continue;
    const seconds = (point.tMs - previous.tMs) / 1000;
    if (seconds <= 0) continue;
    const metres = (point.dist ?? 0) - (previous.dist ?? 0);
    point.speed = round(metres / seconds, 3);
  }

  // Duration and moving time.
  let elapsedSeconds;
  const times = points.filter((point) => point.tMs !== undefined);
  if (times.length >= 2) {
    elapsedSeconds = (times[times.length - 1].tMs - times[0].tMs) / 1000;
  }
  let movingSeconds = 0;
  let movingKnown = false;
  for (let i = 1; i < points.length; i += 1) {
    const point = points[i];
    const previous = points[i - 1];
    if (point.tMs === undefined || previous.tMs === undefined) continue;
    const seconds = (point.tMs - previous.tMs) / 1000;
    if (seconds <= 0 || seconds > 300) continue;
    const metres = Math.abs((point.dist ?? 0) - (previous.dist ?? 0));
    const speed = point.speed ?? previous.speed;
    const moving = speed !== undefined ? speed >= MOVING_SPEED_THRESHOLD : metres >= 0.3;
    if (moving) movingSeconds += seconds;
    movingKnown = true;
  }

  // Elevation change with hysteresis so GPS/barometric noise is not summed.
  let ascent = 0;
  let descent = 0;
  const elevations = points.filter((point) => point.ele !== undefined).map((point) => point.ele);
  if (elevations.length >= 2) {
    let reference = elevations[0];
    for (const elevation of elevations) {
      const delta = elevation - reference;
      if (delta >= ELEVATION_HYSTERESIS_M) {
        ascent += delta;
        reference = elevation;
      } else if (delta <= -ELEVATION_HYSTERESIS_M) {
        descent += -delta;
        reference = elevation;
      }
    }
  }

  const heartRates = points.filter((point) => point.hr !== undefined).map((point) => point.hr);
  const cadences = points.filter((point) => point.cad !== undefined).map((point) => point.cad);
  const powers = points.filter((point) => point.power !== undefined).map((point) => point.power);
  const temperatures = points
    .filter((point) => point.temp !== undefined)
    .map((point) => point.temp);
  const speeds = points.filter((point) => point.speed !== undefined).map((point) => point.speed);
  const totalDistance = hadFileDistance
    ? points[points.length - 1]?.dist ?? cumulative
    : cumulative;

  // A speed derived from positions inherits every metre of GPS jitter, so the
  // single-sample maximum overstates the real peak badly (a 5 m position error
  // in one 1 Hz step reads as 18 km/h). When the file carries no speed of its
  // own, report the peak of a 3-sample rolling mean and keep the raw
  // single-sample maximum beside it.
  const rawMaxSpeed = round(maxOrUndefined(speeds), 3);
  let maxSpeed = rawMaxSpeed;
  let maxSpeedRaw;
  let maxSpeedWindow;
  if (!hadFileSpeed && speeds.length >= 3) {
    let best = 0;
    for (let i = 2; i < speeds.length; i += 1) {
      const window = (speeds[i] + speeds[i - 1] + speeds[i - 2]) / 3;
      if (window > best) best = window;
    }
    maxSpeed = round(best, 3);
    maxSpeedRaw = rawMaxSpeed;
    maxSpeedWindow = 3;
  }

  return {
    distanceMeters: totalDistance > 0 ? totalDistance : undefined,
    elapsedSeconds,
    movingSeconds: movingKnown ? movingSeconds : undefined,
    ascentMeters: ascent > 0 ? ascent : undefined,
    descentMeters: descent > 0 ? descent : undefined,
    minAltitude: minOrUndefined(elevations),
    maxAltitude: maxOrUndefined(elevations),
    avgHeartRate: round(mean(heartRates), 1),
    maxHeartRate: maxOrUndefined(heartRates),
    minHeartRate: minOrUndefined(heartRates),
    avgCadence: round(mean(cadences), 1),
    maxCadence: maxOrUndefined(cadences),
    avgPower: round(mean(powers), 1),
    maxPower: maxOrUndefined(powers),
    avgTemperature: round(mean(temperatures), 1),
    avgSpeed: round(mean(speeds), 3),
    maxSpeed,
    maxSpeedRaw,
    maxSpeedWindow,
    speedDerived: hadFileSpeed ? undefined : true,
    gpsPointCount: points.filter((point) => point.lat !== undefined).length,
    heartRatePointCount: heartRates.length,
    sampleIntervalSeconds: sampleInterval(points),
  };
}

/** Per-kilometre splits with interpolated boundary times. */
function deriveSplits(activity, splitMeters = 1000) {
  const points = activity.points.filter((point) => point.dist !== undefined);
  if (points.length < 2) return [];
  const total = points[points.length - 1].dist;
  if (!(total >= splitMeters)) return [];

  const buckets = [];
  for (const point of points) {
    const index = Math.min(Math.floor(point.dist / splitMeters), Math.floor(total / splitMeters));
    if (buckets[index] === undefined) {
      buckets[index] = { index, heartRates: [], cadences: [], powers: [], startTime: point.t };
    }
    const bucket = buckets[index];
    if (bucket.startTime === undefined && point.t !== undefined) bucket.startTime = point.t;
    if (point.hr !== undefined) bucket.heartRates.push(point.hr);
    if (point.cad !== undefined) bucket.cadences.push(point.cad);
    if (point.power !== undefined) bucket.powers.push(point.power);
    bucket.endTime = point.t;
    bucket.endDist = point.dist;
  }

  // Interpolate each split boundary time from the bracketing samples.
  const boundaries = [];
  for (let boundary = splitMeters; boundary <= total; boundary += splitMeters) {
    let at;
    for (let i = 1; i < points.length; i += 1) {
      if (points[i].dist >= boundary) {
        const previous = points[i - 1];
        const current = points[i];
        if (
          previous.tMs !== undefined &&
          current.tMs !== undefined &&
          current.dist > previous.dist
        ) {
          const fraction = (boundary - previous.dist) / (current.dist - previous.dist);
          at = previous.tMs + fraction * (current.tMs - previous.tMs);
        } else {
          at = current.tMs;
        }
        break;
      }
    }
    boundaries.push(at);
  }

  const splits = [];
  let startMs = points.find((point) => point.tMs !== undefined)?.tMs;
  for (let index = 0; index < boundaries.length; index += 1) {
    const endMs = boundaries[index];
    const bucket = buckets[index];
    const duration =
      startMs !== undefined && endMs !== undefined ? (endMs - startMs) / 1000 : undefined;
    splits.push({
      index: index + 1,
      distanceMeters: round(
        Math.min((index + 1) * splitMeters, total) - index * splitMeters,
        1,
      ),
      durationSeconds: round(duration, 1),
      paceSecondsPerKm: duration !== undefined ? round(duration / (splitMeters / 1000), 1) : undefined,
      startTime: bucket?.startTime,
      avgHeartRate: round(mean(bucket?.heartRates ?? []), 1),
      maxHeartRate: maxOrUndefined(bucket?.heartRates ?? []),
      avgCadence: round(mean(bucket?.cadences ?? []), 1),
      avgPower: round(mean(bucket?.powers ?? []), 1),
    });
    startMs = endMs;
  }

  // Trailing partial split.
  const remainder = total - boundaries.length * splitMeters;
  if (remainder > splitMeters * 0.05) {
    const bucket = buckets[boundaries.length];
    const endMs = points[points.length - 1].tMs;
    const duration =
      startMs !== undefined && endMs !== undefined ? (endMs - startMs) / 1000 : undefined;
    splits.push({
      index: boundaries.length + 1,
      distanceMeters: round(remainder, 1),
      durationSeconds: round(duration, 1),
      paceSecondsPerKm:
        duration !== undefined ? round(duration / (remainder / 1000), 1) : undefined,
      startTime: bucket?.startTime,
      avgHeartRate: round(mean(bucket?.heartRates ?? []), 1),
      maxHeartRate: maxOrUndefined(bucket?.heartRates ?? []),
      avgCadence: round(mean(bucket?.cadences ?? []), 1),
      avgPower: round(mean(bucket?.powers ?? []), 1),
    });
  }
  return splits;
}

/** Time spent in five heart-rate zones, as fractions of observed maximum. */
function deriveHeartRateZones(activity, maxHeartRate) {
  if (maxHeartRate === undefined || maxHeartRate <= 0) return undefined;
  const bounds = [0.6, 0.7, 0.8, 0.9];
  const seconds = [0, 0, 0, 0, 0];
  let observed = false;
  for (let i = 1; i < activity.points.length; i += 1) {
    const point = activity.points[i];
    const previous = activity.points[i - 1];
    if (point.hr === undefined || point.tMs === undefined || previous.tMs === undefined) continue;
    const delta = (point.tMs - previous.tMs) / 1000;
    if (delta <= 0 || delta > 300) continue;
    const ratio = point.hr / maxHeartRate;
    let zone = 4;
    for (let z = 0; z < bounds.length; z += 1) {
      if (ratio < bounds[z]) {
        zone = z;
        break;
      }
    }
    seconds[zone] += delta;
    observed = true;
  }
  if (!observed) return undefined;
  const total = seconds.reduce((sum, value) => sum + value, 0);
  const labels = ['Z1 recovery', 'Z2 easy', 'Z3 tempo', 'Z4 threshold', 'Z5 max'];
  return labels.map((label, index) => ({
    zone: index + 1,
    label,
    seconds: round(seconds[index], 1),
    percent: total > 0 ? round((seconds[index] / total) * 100, 1) : 0,
  }));
}

/**
 * Normalise one reader's output into the shape the tool returns.
 * @param {object} activity - output of readGpx/readTcx/readFit.
 * @param {{points?: 'none'|'summary'|'full', maxPoints?: number, splits?: boolean}} options
 */
export function normalize(activity, options = {}) {
  const pointsMode = options.points ?? 'none';
  const maxPoints = options.maxPoints ?? 500;

  // Timestamps are needed for ordering, so stamp them before the sort; the
  // derivation pass below re-checks and keeps the existing values.
  for (const point of activity.points) {
    if (point.t !== undefined && point.tMs === undefined) {
      const parsed = Date.parse(point.t);
      if (Number.isFinite(parsed)) point.tMs = parsed;
    }
  }
  activity.points.sort((a, b) => {
    if (a.tMs === undefined || b.tMs === undefined) return 0;
    return a.tMs - b.tMs;
  });

  const derived = deriveFromPoints(activity);
  const totals = { ...(activity.totals ?? {}) };
  const stats = { ...(activity.stats ?? {}) };

  // File-declared values win; derived values fill the gaps.
  for (const [key, value] of Object.entries(derived)) {
    if (value === undefined) continue;
    if (key === 'distanceMeters' || key === 'elapsedSeconds' || key === 'movingSeconds' ||
        key === 'ascentMeters' || key === 'descentMeters') {
      if (totals[key] === undefined) totals[key] = round(value, 1);
    } else if (stats[key] === undefined) {
      stats[key] = value;
    }
  }

  const startTime =
    activity.startTime ??
    activity.points.find((point) => point.t !== undefined)?.t;
  const endTime =
    activity.points.length > 0
      ? [...activity.points].reverse().find((point) => point.t !== undefined)?.t
      : undefined;

  if (totals.movingSeconds === undefined) totals.movingSeconds = totals.elapsedSeconds;
  if (totals.timerSeconds === undefined) totals.timerSeconds = totals.movingSeconds;
  // Distance over time is the more trustworthy average speed when both exist.
  if (totals.distanceMeters !== undefined && totals.elapsedSeconds > 0) {
    stats.avgSpeed = round(totals.distanceMeters / totals.elapsedSeconds, 3);
  }
  if (stats.avgSpeed !== undefined && stats.avgSpeed > 0) {
    stats.avgPaceSecondsPerKm = round(1000 / stats.avgSpeed, 1);
  }
  if (stats.maxSpeed !== undefined && stats.maxSpeed > 0) {
    stats.bestPaceSecondsPerKm = round(1000 / stats.maxSpeed, 1);
  }
  if (totals.distanceMeters !== undefined && totals.movingSeconds > 0) {
    stats.movingPaceSecondsPerKm = round(1000 / (totals.distanceMeters / totals.movingSeconds), 1);
  }

  const splits = options.splits === false ? [] : deriveSplits(activity);
  const heartRateZones = deriveHeartRateZones(activity, stats.maxHeartRate);

  let points;
  let pointsSampled = false;
  if (pointsMode === 'full') {
    if (activity.points.length > maxPoints) {
      points = downsample(activity.points, maxPoints);
      pointsSampled = true;
    } else {
      points = activity.points.map(cleanPoint);
    }
  } else if (pointsMode === 'summary') {
    points = summarizeSeries(activity.points);
  }

  const warnings = [...(activity.warnings ?? [])];

  return losslessJson({
    container: activity.container,
    path: activity.path,
    name: activity.name,
    description: activity.description,
    sport: activity.sport,
    subSport: activity.subSport,
    fileType: activity.fileType,
    startTime,
    endTime,
    pointCount: activity.points.length,
    pointsSampled,
    device: prune(activity.device),
    creator: activity.creator,
    totals: prune(totals),
    stats: prune(stats),
    splits: splits.map(prune),
    heartRateZones,
    laps: (activity.laps ?? []).map(prune),
    events: (activity.events ?? []).slice(0, 50).map(prune),
    waypoints: (activity.waypoints ?? []).slice(0, 100).map((waypoint) => prune(waypoint)),
    routes: (activity.routes ?? []).map(prune),
    tracks: (activity.tracks ?? []).map(prune),
    activities: (activity.activities ?? []).map(prune),
    courses: (activity.courses ?? []).map(prune),
    lengths: (activity.lengths ?? []).slice(0, 100).map(prune),
    fit: activity.fit,
    extras: prune(activity.extras),
    warnings,
    ...(points !== undefined ? { points } : {}),
  });
}

function cleanPoint(point) {
  const out = {};
  for (const key of ['t', 'lat', 'lon', 'ele', 'hr', 'cad', 'speed', 'power', 'temp', 'dist', 'grad']) {
    if (point[key] !== undefined) out[key] = point[key];
  }
  return out;
}

function downsample(points, maxPoints) {
  const step = points.length / maxPoints;
  const out = [];
  for (let i = 0; i < maxPoints; i += 1) out.push(cleanPoint(points[Math.floor(i * step)]));
  const last = points[points.length - 1];
  if (out[out.length - 1].t !== last.t) out.push(cleanPoint(last));
  return out;
}

/** Bucket the series so a long activity still reports where the extremes were. */
function summarizeSeries(points) {
  const buckets = 60;
  if (points.length <= buckets) return points.map(cleanPoint);
  const size = Math.ceil(points.length / buckets);
  const out = [];
  for (let start = 0; start < points.length; start += size) {
    const slice = points.slice(start, start + size);
    const withT = slice.filter((point) => point.t !== undefined);
    const heartRates = slice.filter((point) => point.hr !== undefined).map((point) => point.hr);
    const cadences = slice.filter((point) => point.cad !== undefined).map((point) => point.cad);
    const speeds = slice.filter((point) => point.speed !== undefined).map((point) => point.speed);
    const elevations = slice.filter((point) => point.ele !== undefined).map((point) => point.ele);
    const positions = slice.filter((point) => point.lat !== undefined);
    const entry = {
      from: withT[0]?.t,
      to: withT[withT.length - 1]?.t,
      samples: slice.length,
      distFrom: slice[0]?.dist,
      distTo: slice[slice.length - 1]?.dist,
    };
    if (heartRates.length > 0) {
      entry.hrAvg = round(mean(heartRates), 1);
      entry.hrMax = maxOrUndefined(heartRates);
    }
    if (cadences.length > 0) entry.cadAvg = round(mean(cadences), 1);
    if (speeds.length > 0) {
      entry.speedAvg = round(mean(speeds), 3);
      entry.speedMax = round(maxOrUndefined(speeds), 3);
    }
    if (elevations.length > 0) {
      entry.eleMin = round(minOrUndefined(elevations), 2);
      entry.eleMax = round(maxOrUndefined(elevations), 2);
    }
    if (positions.length > 0) {
      const middle = positions[Math.floor(positions.length / 2)];
      entry.lat = middle.lat;
      entry.lon = middle.lon;
    }
    out.push(entry);
  }
  return out;
}

function prune(object) {
  if (object === undefined || object === null) return object;
  const out = {};
  for (const [key, value] of Object.entries(object)) {
    if (value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * Structural copy that survives a JSON round trip.
 *
 * DSH validates a tool whose `output.schema` is `{ type: 'json' }` by comparing
 * the returned value with `JSON.parse(JSON.stringify(value))`, so a single
 * property holding `undefined`, a non-finite number or a non-plain object makes
 * the whole tool result invalid ("value is not lossless JSON"). Readers are
 * written defensively and leave such properties behind — an absent description,
 * a developer field without a scale — so the payload is normalised here, once,
 * for every consumer. `undefined` properties are dropped, non-finite numbers
 * become `null`, array holes become `null`, and dates become ISO strings.
 */
export function losslessJson(value) {
  if (value === null) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    // `-0` survives `JSON.stringify` but not DSH's lossless-JSON walk, which
    // rejects it explicitly; `0` is what a round trip produces anyway.
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  // `undefined`, functions and symbols have no JSON form: callers drop the key.
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return undefined;
  }
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    const out = [];
    for (let index = 0; index < value.length; index += 1) {
      const cleaned = losslessJson(value[index]);
      out.push(cleaned === undefined ? null : cleaned);
    }
    return out;
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      const cleaned = losslessJson(child);
      if (cleaned !== undefined) out[key] = cleaned;
    }
    return out;
  }
  return undefined;
}

/** Compact text rendering of a normalised activity. */
export function renderSummary(summary, options = {}) {
  const lines = [];
  const heading = [summary.container?.toUpperCase(), summary.path].filter(Boolean).join(' · ');
  lines.push(heading);
  const title = [summary.name, summary.sport && `[${summary.sport}]`]
    .filter(Boolean)
    .join(' ');
  if (title !== '') lines.push(title);

  const totals = summary.totals ?? {};
  const stats = summary.stats ?? {};
  const when = [];
  if (summary.startTime !== undefined) when.push(`start ${summary.startTime}`);
  if (summary.endTime !== undefined) when.push(`end ${summary.endTime}`);
  if (when.length > 0) lines.push(when.join(' · '));

  const duration = [];
  if (totals.elapsedSeconds !== undefined) {
    duration.push(`elapsed ${formatDuration(totals.elapsedSeconds)}`);
  }
  if (totals.movingSeconds !== undefined && totals.movingSeconds !== totals.elapsedSeconds) {
    duration.push(`moving ${formatDuration(totals.movingSeconds)}`);
  }
  if (totals.timerSeconds !== undefined && totals.timerSeconds !== totals.elapsedSeconds) {
    duration.push(`timer ${formatDuration(totals.timerSeconds)}`);
  }
  if (duration.length > 0) lines.push(duration.join(' · '));

  const distance = [];
  if (totals.distanceMeters !== undefined) {
    distance.push(`distance ${(totals.distanceMeters / 1000).toFixed(2)} km`);
  }
  if (stats.avgPaceSecondsPerKm !== undefined) {
    distance.push(`avg pace ${formatPace(stats.avgPaceSecondsPerKm)}`);
  }
  if (stats.movingPaceSecondsPerKm !== undefined && totals.movingSeconds !== totals.elapsedSeconds) {
    distance.push(`moving pace ${formatPace(stats.movingPaceSecondsPerKm)}`);
  }
  if (stats.avgSpeed !== undefined) distance.push(`avg speed ${(stats.avgSpeed * 3.6).toFixed(2)} km/h`);
  if (stats.maxSpeed !== undefined) {
    // Flag a smoothed peak so the number is not read as a file-reported record.
    const window = stats.maxSpeedWindow !== undefined ? ` (${stats.maxSpeedWindow} s mean)` : '';
    distance.push(`max ${(stats.maxSpeed * 3.6).toFixed(2)} km/h${window}`);
  }
  if (distance.length > 0) lines.push(distance.join(' · '));

  const elevation = [];
  if (totals.ascentMeters !== undefined) elevation.push(`+${Math.round(totals.ascentMeters)} m`);
  if (totals.descentMeters !== undefined) elevation.push(`-${Math.round(totals.descentMeters)} m`);
  if (stats.minAltitude !== undefined) {
    elevation.push(`altitude ${Math.round(stats.minAltitude)}-${Math.round(stats.maxAltitude)} m`);
  }
  if (elevation.length > 0) lines.push(`elevation ${elevation.join(' · ')}`);

  const effort = [];
  if (stats.avgHeartRate !== undefined) {
    effort.push(`HR avg ${Math.round(stats.avgHeartRate)} / max ${stats.maxHeartRate} bpm`);
  }
  if (stats.avgCadence !== undefined) {
    effort.push(`cadence avg ${Math.round(stats.avgCadence)} / max ${stats.maxCadence} rpm`);
  }
  if (stats.avgPower !== undefined) {
    effort.push(`power avg ${Math.round(stats.avgPower)} / max ${stats.maxPower} W`);
  }
  if (stats.avgTemperature !== undefined) effort.push(`${stats.avgTemperature} °C`);
  if (totals.calories !== undefined) effort.push(`${totals.calories} kcal`);
  if (effort.length > 0) lines.push(effort.join(' · '));

  const sample = [];
  sample.push(`${summary.pointCount ?? 0} points`);
  if (stats.gpsPointCount !== undefined) sample.push(`${stats.gpsPointCount} with GPS`);
  if (stats.sampleIntervalSeconds !== undefined) {
    sample.push(`~${stats.sampleIntervalSeconds.toFixed(1)} s sampling`);
  }
  if (stats.heartRatePointCount !== undefined && stats.heartRatePointCount > 0) {
    sample.push(`${stats.heartRatePointCount} HR samples`);
  }
  lines.push(sample.join(' · '));

  if (summary.heartRateZones !== undefined) {
    lines.push(
      `HR zones: ${summary.heartRateZones
        .map((zone) => `${zone.label} ${formatDuration(zone.seconds)} (${zone.percent}%)`)
        .join(' · ')}`,
    );
  }

  if ((summary.splits ?? []).length > 0) {
    lines.push('splits:');
    for (const split of summary.splits) {
      const parts = [
        `#${String(split.index).padStart(2, ' ')}`,
        (split.distanceMeters / 1000).toFixed(2).padStart(5, ' ') + ' km',
        (formatDuration(split.durationSeconds) ?? '--').padStart(7, ' '),
        (formatPace(split.paceSecondsPerKm) ?? '--').padStart(9, ' '),
      ];
      if (split.avgHeartRate !== undefined) parts.push(`${Math.round(split.avgHeartRate)} bpm`);
      if (split.avgCadence !== undefined) parts.push(`${Math.round(split.avgCadence)} rpm`);
      if (split.avgPower !== undefined) parts.push(`${Math.round(split.avgPower)} W`);
      lines.push(`  ${parts.join('  ')}`);
    }
  }

  if (summary.device !== undefined && Object.keys(summary.device).length > 0) {
    lines.push(`device: ${JSON.stringify(summary.device)}`);
  }
  if (summary.fit !== undefined) {
    const counts = Object.entries(summary.fit.counts ?? {})
      .map(([kind, count]) => `${kind}=${count}`)
      .join(' ');
    lines.push(`FIT messages: ${counts}`);
  }
  if (options.pointsNote !== undefined) lines.push(options.pointsNote);
  if ((summary.warnings ?? []).length > 0) {
    lines.push(`warnings: ${summary.warnings.join('; ')}`);
  }
  return lines.join('\n');
}
