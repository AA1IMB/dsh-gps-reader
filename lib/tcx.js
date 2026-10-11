/**
 * TCX reader (Garmin TrainingCenterDatabase v1/v2).
 *
 * Reads `<Activities>` (Activity/Lap/Track/Trackpoint) and `<Courses>`
 * (Course/Lap/Track/CoursePoint). Cadence prefers the running-specific
 * `<RunCadence>` from `<Extensions><TPX>` over the bike-shaped `<Cadence>`,
 * because most running producers leave `<Cadence>` at zero.
 */

import { attr, attrNum, child, children, flattenLeaves, num, parseXml, text } from './xml.js';

/** TCX `Sport` / `<Activity Sport>` values mapped to FIT-style sport names. */
const SPORT_MAP = {
  running: { sport: 'running', subSport: 'street' },
  biking: { sport: 'cycling' },
  bicycling: { sport: 'cycling' },
  cycling: { sport: 'cycling' },
  swimming: { sport: 'swimming' },
  walking: { sport: 'walking' },
  hiking: { sport: 'hiking' },
  rowing: { sport: 'rowing' },
  other: { sport: 'generic' },
};

function normalizeSport(value) {
  if (value === undefined) return {};
  return SPORT_MAP[value.trim().toLowerCase()] ?? { sport: value.trim().toLowerCase() };
}

function extensionMap(node) {
  const ext = child(node, 'extensions');
  if (ext === undefined) return {};
  const flat = flattenLeaves(ext);
  const out = {};
  for (const [key, value] of Object.entries(flat)) {
    const folded = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (out[folded] === undefined) out[folded] = value;
  }
  return out;
}

function extNumber(map, ...keys) {
  for (const key of keys) {
    const value = map[key];
    if (value === undefined) continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function readTrackpoint(node) {
  const point = {};
  const time = text(node, 'time');
  if (time !== undefined) point.t = time;

  const position = child(node, 'position');
  if (position !== undefined) {
    const lat = num(position, 'latitudedegrees');
    const lon = num(position, 'longitudedegrees');
    if (lat !== undefined && lon !== undefined) {
      point.lat = lat;
      point.lon = lon;
    }
  }

  const ele = num(node, 'altitudemeters');
  if (ele !== undefined) point.ele = ele;
  const dist = num(node, 'distancemeters');
  if (dist !== undefined) point.dist = dist;
  const hr = num(node, 'heartratebpm', 'value');
  if (hr !== undefined) point.hr = Math.round(hr);
  const cadence = num(node, 'cadence');

  const ext = extensionMap(node);
  const runCadence = extNumber(ext, 'runcadence', 'runcadencevalue');
  const resolvedCadence = runCadence !== undefined ? runCadence : cadence;
  if (resolvedCadence !== undefined) point.cad = Math.round(resolvedCadence);

  const speed = extNumber(ext, 'speed', 'enhancedspeed');
  if (speed !== undefined) point.speed = speed;
  const watts = extNumber(ext, 'watts', 'power');
  if (watts !== undefined) point.power = Math.round(watts);

  if (Object.keys(point).length === 0) return undefined;
  return point;
}

function readLap(lap) {
  const track = child(lap, 'track');
  const points = [];
  if (track !== undefined) {
    for (const trackpoint of children(track, 'trackpoint')) {
      const point = readTrackpoint(trackpoint);
      if (point !== undefined) points.push(point);
    }
  }
  const extensions = extensionMap(lap);
  const record = {
    startTime: attr(lap, 'StartTime'),
    totalTimeSeconds: num(lap, 'totaltimeSeconds'),
    distanceMeters: num(lap, 'distancemeters'),
    maxSpeed: num(lap, 'maximumspeed'),
    calories: num(lap, 'calories'),
    avgHeartRate: num(lap, 'averageheartratebpm', 'value'),
    maxHeartRate: num(lap, 'maximumheartratebpm', 'value'),
    cadence: num(lap, 'cadence'),
    avgRunCadence: extNumber(extensions, 'avgruncadence'),
    maxRunCadence: extNumber(extensions, 'maxruncadence'),
    avgSpeed: extNumber(extensions, 'avgspeed'),
    avgWatts: extNumber(extensions, 'avgwatts'),
    maxWatts: extNumber(extensions, 'maxwatts'),
    steps: extNumber(extensions, 'steps'),
    intensity: text(lap, 'intensity'),
    triggerMethod: text(lap, 'triggermethod'),
    notes: text(lap, 'notes'),
    points,
  };
  if (record.startTime === undefined && points.length > 0) record.startTime = points[0].t;
  return record;
}

function topLevelCreator(root) {
  for (const key of ['author', 'creator']) {
    const node = child(root, key);
    if (node === undefined) continue;
    const name = text(node, 'name');
    const build = child(node, 'build');
    const version = build !== undefined ? text(build, 'version', 'versionmajor') : undefined;
    const partNumber = text(node, 'partnumber');
    if (name !== undefined || partNumber !== undefined || version !== undefined) {
      return { name, version, partNumber };
    }
  }
  return undefined;
}

/**
 * Parse a TCX document.
 * @param {string} source - decoded file text.
 * @param {{path?: string}} context
 * @returns {object} intermediate activity structure.
 */
export function readTcx(source, context = {}) {
  const root = parseXml(source);
  if (root === null || root.local.toLowerCase() !== 'trainingcenterdatabase') {
    throw new Error('not a TCX document (missing <TrainingCenterDatabase> root element)');
  }

  const warnings = [];
  const result = {
    container: 'tcx',
    path: context.path,
    warnings,
    points: [],
    laps: [],
    events: [],
    activities: [],
    courses: [],
    extras: {},
    totals: {},
    stats: {},
    device: {},
  };

  const author = topLevelCreator(root);
  if (author !== undefined) {
    result.creator = author.name ?? author.partNumber;
    if (author.version !== undefined) result.device.software = author.version;
    if (author.partNumber !== undefined) result.device.product = author.partNumber;
  }

  const activitiesNode = child(root, 'activities');
  const activityNodes = activitiesNode !== undefined ? children(activitiesNode, 'activity') : [];

  for (const activity of activityNodes) {
    const laps = children(activity, 'lap').map(readLap);
    const points = [];
    for (const lap of laps) for (const point of lap.points) points.push(point);
    const sport = normalizeSport(attr(activity, 'sport'));
    result.activities.push({
      id: text(activity, 'id'),
      sport: sport.sport,
      subSport: sport.subSport,
      notes: text(activity, 'notes'),
      lapCount: laps.length,
      pointCount: points.length,
    });
    // The primary activity owns the flat point/lap arrays.
    if (result.points.length === 0 && points.length > 0) {
      result.points = points;
      result.laps = laps;
      result.sport = sport.sport;
      result.subSport = sport.subSport;
      result.name = text(activity, 'notes') ?? text(activity, 'id');
      result.startTime = text(activity, 'id') ?? laps[0]?.startTime;
      result.activityNotes = text(activity, 'notes');
    }
  }

  if (activityNodes.length === 0) {
    const coursesNode = child(root, 'courses');
    const courseNodes = coursesNode !== undefined ? children(coursesNode, 'course') : [];
    for (const course of courseNodes) {
      const courseName = text(course, 'name');
      const laps = children(course, 'lap').map(readLap);
      const points = [];
      for (const lap of laps) for (const point of lap.points) points.push(point);
      const coursePoints = children(course, 'coursepoint').map((node) => ({
        name: text(node, 'name'),
        t: text(node, 'time'),
        pointType: text(node, 'pointtype'),
        notes: text(node, 'notes'),
        lat: num(node, 'position', 'latitudedegrees'),
        lon: num(node, 'position', 'longitudedegrees'),
      }));
      result.courses.push({
        name: courseName,
        lapCount: laps.length,
        pointCount: points.length,
        coursePointCount: coursePoints.length,
      });
      if (result.points.length === 0 && points.length > 0) {
        result.points = points;
        result.laps = laps;
        result.name = courseName;
        result.startTime = laps[0]?.startTime ?? points[0]?.t;
        result.waypoints = coursePoints;
      }
    }
    if (courseNodes.length > 0) {
      warnings.push('file is a TCX course, not a recorded activity: totals reflect the planned route');
    }
  }

  if (result.points.length === 0) {
    warnings.push('no track points found in this TCX file');
  }
  if (activityNodes.length > 1) {
    warnings.push(
      `${activityNodes.length} activities in one file; the summary describes the first (see "activities" for all)`,
    );
  }
  const hasHr = result.points.some((point) => point.hr !== undefined);
  if (result.points.length > 0 && !hasHr) warnings.push('no heart-rate samples in this TCX file');

  return result;
}

/** Cheap sniff: does this text look like TCX? */
export function looksLikeTcx(source) {
  const head = source.slice(0, 4096).toLowerCase();
  return head.includes('trainingcenterdatabase') || head.includes('<activities') || head.includes('<courses');
}
