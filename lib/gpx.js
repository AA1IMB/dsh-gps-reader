/**
 * GPX 1.0 / 1.1 reader.
 *
 * Produces the shared intermediate activity structure consumed by model.js.
 * Both the modern `<trkpt>` shape and the older 1.0 elements are read, and the
 * open-ended `<extensions>` block is flattened so heart rate, cadence, power
 * and temperature survive regardless of which namespace a producer chose
 * (Garmin `gpxtpx:`, Cluetrust `gpxdata:`, Strava bare `<power>`, ...).
 */

import { attr, attrNum, child, children, flattenLeaves, num, parseXml, text, walk } from './xml.js';

/** Local names that carry a given metric inside `<extensions>`. */
const EXT_ALIASES = {
  hr: ['hr', 'heartrate', 'heart_rate', 'heartratebpm', 'bpm', 'pulse'],
  cad: ['cad', 'cadence', 'runcadence', 'run_cadence', 'cadence_rpm'],
  power: ['power', 'watts', 'pwr', 'powerwatts'],
  temp: ['atemp', 'temp', 'temperature', 'wtemp', 'airtemp'],
  speed: ['speed', 'enhancedspeed', 'enhanced_speed', 'velocity'],
  dist: ['distance', 'dist', 'distancemeters', 'odometer'],
  grad: ['grade', 'gradient', 'slope', 'inclination'],
  stridelen: ['stridelength', 'step_length'],
  vertosc: ['verticaloscillation', 'vertical_oscillation'],
  gct: ['groundcontacttime', 'stance_time', 'gct'],
};

function pickExtension(map, aliases) {
  for (const key of aliases) {
    const value = map[key];
    if (value === undefined) continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** Candidate extension keys, lower-cased with separators removed. */
function normalizedExtensions(node) {
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

function readPoint(node) {
  const lat = attrNum(node, 'lat');
  const lon = attrNum(node, 'lon');
  if (lat === undefined || lon === undefined) return undefined;
  const point = { lat, lon };

  const ele = num(node, 'ele') ?? num(node, 'elevation');
  if (ele !== undefined) point.ele = ele;

  const time = text(node, 'time');
  if (time !== undefined) point.t = time;

  const speed = num(node, 'speed');
  if (speed !== undefined) point.speed = speed;
  const course = num(node, 'course');
  if (course !== undefined) point.course = course;

  const sat = num(node, 'sat');
  if (sat !== undefined) point.sat = sat;
  const hdop = num(node, 'hdop');
  if (hdop !== undefined) point.hdop = hdop;
  const vdop = num(node, 'vdop');
  if (vdop !== undefined) point.vdop = vdop;
  const pdop = num(node, 'pdop');
  if (pdop !== undefined) point.pdop = pdop;

  const ext = normalizedExtensions(node);
  const hr = pickExtension(ext, EXT_ALIASES.hr);
  if (hr !== undefined) point.hr = Math.round(hr);
  const cad = pickExtension(ext, EXT_ALIASES.cad);
  if (cad !== undefined) point.cad = Math.round(cad);
  const power = pickExtension(ext, EXT_ALIASES.power);
  if (power !== undefined) point.power = Math.round(power);
  const temp = pickExtension(ext, EXT_ALIASES.temp);
  if (temp !== undefined) point.temp = temp;
  if (point.speed === undefined) {
    const extSpeed = pickExtension(ext, EXT_ALIASES.speed);
    if (extSpeed !== undefined) point.speed = extSpeed;
  }
  const dist = pickExtension(ext, EXT_ALIASES.dist);
  if (dist !== undefined) point.dist = dist;
  const grad = pickExtension(ext, EXT_ALIASES.grad);
  if (grad !== undefined) point.grad = grad;

  return point;
}

function nameOf(node) {
  return text(node, 'name') ?? text(node, 'desc') ?? undefined;
}

/**
 * Parse a GPX document.
 * @param {string} source - decoded file text.
 * @param {{path?: string}} context
 * @returns {object} intermediate activity structure.
 */
export function readGpx(source, context = {}) {
  const root = parseXml(source);
  const warnings = [];
  const result = {
    container: 'gpx',
    path: context.path,
    creator: attr(root, 'creator'),
    version: attr(root, 'version'),
    warnings,
    points: [],
    laps: [],
    events: [],
    waypoints: [],
    routes: [],
    tracks: [],
    extras: {},
    totals: {},
    stats: {},
    device: {},
  };

  if (root === null || root.local.toLowerCase() !== 'gpx') {
    throw new Error('not a GPX document (missing <gpx> root element)');
  }

  const metadata = child(root, 'metadata');
  if (metadata !== undefined) {
    result.name = text(metadata, 'name');
    result.description = text(metadata, 'desc');
    result.keywords = text(metadata, 'keywords');
    result.startTime = text(metadata, 'time');
    const author = child(metadata, 'author');
    if (author !== undefined) {
      result.author = text(author, 'name');
      const link = child(author, 'link');
      if (link !== undefined) result.authorLink = attr(link, 'href');
    }
    const bounds = child(metadata, 'bounds');
    if (bounds !== undefined) {
      result.bounds = {
        minLat: attrNum(bounds, 'minlat'),
        minLon: attrNum(bounds, 'minlon'),
        maxLat: attrNum(bounds, 'maxlat'),
        maxLon: attrNum(bounds, 'maxlon'),
      };
    }
  }
  // GPX 1.0 keeps metadata directly under <gpx>.
  if (result.name === undefined) {
    const gpxName = text(root, 'name');
    if (gpxName !== undefined) result.name = gpxName;
  }

  for (const wpt of children(root, 'wpt')) {
    const lat = attrNum(wpt, 'lat');
    const lon = attrNum(wpt, 'lon');
    if (lat === undefined || lon === undefined) continue;
    result.waypoints.push({
      lat,
      lon,
      name: nameOf(wpt),
      ele: num(wpt, 'ele'),
      t: text(wpt, 'time'),
      sym: text(wpt, 'sym'),
      type: text(wpt, 'type'),
    });
  }

  for (const rte of children(root, 'rte')) {
    const points = [];
    for (const rtept of children(rte, 'rtept')) {
      const point = readPoint(rtept);
      if (point !== undefined) points.push(point);
    }
    result.routes.push({ name: nameOf(rte), pointCount: points.length, points });
  }

  const gpxExt = child(root, 'extensions');
  if (gpxExt !== undefined) result.extras = flattenLeaves(gpxExt);

  let skipped = 0;
  for (const trk of children(root, 'trk')) {
    const segments = children(trk, 'trkseg');
    const track = {
      name: nameOf(trk),
      type: text(trk, 'type'),
      number: num(trk, 'number'),
      segments: segments.length,
      points: 0,
    };
    for (const seg of segments) {
      for (const trkpt of children(seg, 'trkpt')) {
        const point = readPoint(trkpt);
        if (point === undefined) {
          skipped += 1;
          continue;
        }
        result.points.push(point);
        track.points += 1;
      }
    }
    result.tracks.push(track);
    if (result.sport === undefined && track.type !== undefined) result.sport = track.type;
  }

  if (result.tracks.length === 0 && result.routes.length > 0) {
    // A route-only file still describes a usable path.
    for (const route of result.routes) {
      for (const point of route.points) result.points.push(point);
    }
    warnings.push('file contains no <trk>; points were taken from <rte> routes');
  }

  // A single track's own name is the activity title in most exports, so it wins
  // over the document-level <metadata><name>; the displaced name is kept.
  if (result.tracks.length === 1 && result.tracks[0].name !== undefined) {
    if (result.name !== undefined && result.name !== result.tracks[0].name) {
      result.extras = { ...(result.extras ?? {}), metadataName: result.name };
    }
    result.name = result.tracks[0].name;
  } else if (result.name === undefined) {
    result.name = result.tracks[0]?.name;
  }
  if (skipped > 0) warnings.push(`${skipped} track point(s) had no latitude/longitude and were skipped`);

  const noTime = result.points.filter((point) => point.t === undefined).length;
  if (noTime === result.points.length && result.points.length > 0) {
    warnings.push('no timestamps in this file: durations, speeds and moving time cannot be derived');
  } else if (noTime > 0) {
    warnings.push(`${noTime} point(s) carry no timestamp`);
  }

  const extensionCount = result.points.filter(
    (point) => point.hr !== undefined || point.cad !== undefined || point.power !== undefined,
  ).length;
  if (result.points.length > 0 && extensionCount === 0) {
    warnings.push(
      'no heart rate, cadence or power in <extensions> — this GPX carries position/elevation/time only',
    );
  }

  return result;
}

/** Cheap sniff: does this text look like GPX? */
export function looksLikeGpx(source) {
  const head = source.slice(0, 4096).toLowerCase();
  return head.includes('<gpx') || head.includes('topografix.com/gpx');
}

/** Collect every distinct top-level extension key (used by the `full` view). */
export function gpxExtensionKeys(source) {
  const root = parseXml(source);
  if (root === null) return [];
  const keys = new Set();
  walk(root, (node) => {
    if (node.local.toLowerCase() !== 'extensions') return;
    for (const key of Object.keys(flattenLeaves(node))) keys.add(key);
  });
  return [...keys].sort();
}
