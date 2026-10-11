/**
 * FIT reader: binary decoder plus normalisation into the shared activity shape.
 *
 * The decoder follows the FIT protocol directly: record headers (normal,
 * definition, compressed-timestamp), local message types, base types with their
 * invalid sentinels, chained file sections, and developer fields declared by
 * `developer_data_id` / `field_description` messages.
 *
 * Standard fields are converted with the official scale/offset metadata in
 * fit-profile.js, so `record.distance` reports metres (not centimetres) and
 * `record.speed` reports m/s (not mm/s).
 */

import {
  BASE_TYPES,
  EVENT_NAMES,
  EVENT_TYPE_NAMES,
  FIELD_META,
  FIELD_NAMES,
  FILE_TYPE_NAMES,
  FIT_EPOCH_SECONDS,
  GLOBAL_NAMES,
  INVALID_VALUES,
  MANUFACTURERS,
  PRODUCT_NAMES,
  SPORT_NAMES,
  SUB_SPORT_NAMES,
} from './fit-profile.js';

const SEMICIRCLE_TO_DEGREES = 180 / 2147483648;

/** FIT CRC-16 (reflected, poly 0xA001) over a byte range. */
const CRC_TABLE = [
  0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401, 0xa001, 0x6c00, 0x7800, 0xb401,
  0x5000, 0x9c01, 0x8801, 0x4400,
];

function crc16(bytes, start, end) {
  let crc = 0;
  for (let i = start; i < end; i += 1) {
    const byte = bytes[i];
    let tmp = CRC_TABLE[crc & 0x0f];
    crc = (crc >> 4) & 0x0fff;
    crc ^= tmp ^ CRC_TABLE[byte & 0x0f];
    tmp = CRC_TABLE[crc & 0x0f];
    crc = (crc >> 4) & 0x0fff;
    crc ^= tmp ^ CRC_TABLE[(byte >> 4) & 0x0f];
  }
  return crc & 0xffff;
}

function reader(bytes, little) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    number(type, offset) {
      switch (type) {
        case 0x01:
          return view.getInt8(offset);
        case 0x02:
        case 0x00:
        case 0x0a:
        case 0x0d:
          return view.getUint8(offset);
        case 0x83:
          return view.getInt16(offset, little);
        case 0x84:
        case 0x8b:
          return view.getUint16(offset, little);
        case 0x85:
          return view.getInt32(offset, little);
        case 0x86:
        case 0x8c:
          return view.getUint32(offset, little);
        case 0x88:
          return view.getFloat32(offset, little);
        case 0x89:
          return view.getFloat64(offset, little);
        case 0x8e:
          return Number(view.getBigInt64(offset, little));
        case 0x8f:
        case 0x90:
          return Number(view.getBigUint64(offset, little));
        default:
          return undefined;
      }
    },
  };
}

function isInvalid(baseTypeId, value, bytes, offset, size) {
  const sentinel = INVALID_VALUES[baseTypeId];
  if (sentinel === undefined) return false;
  if (baseTypeId === 0x88 || baseTypeId === 0x89) {
    for (let i = 0; i < size; i += 1) if (bytes[offset + i] !== 0xff) return false;
    return true;
  }
  if (typeof sentinel === 'bigint') return BigInt(value) === sentinel;
  return value === sentinel;
}

function decodeString(bytes, offset, size) {
  let end = offset + size;
  while (end > offset && bytes[end - 1] === 0x00) end -= 1;
  let out = '';
  for (let i = offset; i < end; i += 1) out += String.fromCharCode(bytes[i]);
  try {
    return decodeURIComponent(escape(out));
  } catch {
    return out;
  }
}

/** Read one field definition list out of the buffer. */
function readFields(bytes, pos, fields, little) {
  const data = reader(bytes, little);
  const out = {};
  let offset = pos;
  for (const field of fields) {
    const size = field.size;
    if (size <= 0) continue;
    const info = BASE_TYPES[field.baseType];
    if (info === undefined) {
      offset += size;
      continue;
    }
    const [typeName, elemSize] = info;
    if (typeName === 'string') {
      const value = decodeString(bytes, offset, size);
      if (value.length > 0) out[field.num] = value;
      offset += size;
      continue;
    }
    const count = Math.floor(size / elemSize);
    const values = [];
    for (let i = 0; i < count; i += 1) {
      const at = offset + i * elemSize;
      if (at + elemSize > bytes.length) break;
      const raw = data.number(field.baseType, at);
      if (raw === undefined || isInvalid(field.baseType, raw, bytes, at, elemSize)) continue;
      values.push(raw);
    }
    if (values.length === 1) out[field.num] = values[0];
    else if (values.length > 1) out[field.num] = values;
    offset += size;
  }
  return [out, offset];
}

function fieldName(kind, num) {
  const table = FIELD_NAMES[kind];
  const name = table !== undefined ? table[num] : undefined;
  return name !== undefined ? name : `unknown_${num}`;
}

/**
 * Apply a field's unit metadata (scale/offset/unit/special transform).
 * Returns `{ value, unit }`; `unit` is undefined when the field has none.
 */
function convert(kind, name, value, meta) {
  const entry = meta[kind]?.[name];
  if (entry === undefined) return { value, unit: undefined };
  const map = (input) => {
    if (entry.as === 'semicircle') return input * SEMICIRCLE_TO_DEGREES;
    if (entry.as === 'date') return new Date((input + FIT_EPOCH_SECONDS) * 1000).toISOString();
    if (entry.as === 'localtime') {
      const shifted = new Date((input + FIT_EPOCH_SECONDS) * 1000);
      return `${shifted.toISOString().slice(0, 19)} (local)`;
    }
    let out = input;
    if (entry.scale !== undefined) out /= entry.scale;
    if (entry.offset !== undefined) out -= entry.offset;
    return out;
  };
  const converted = Array.isArray(value) ? value.map(map) : map(value);
  return { value: converted, unit: entry.unit };
}

/**
 * Decode every message in a FIT byte stream.
 * @param {Uint8Array} bytes
 * @returns {{header: object, sections: object[], messages: object[], counts: object, devFields: object[], warnings: string[]}}
 */
export function parseFit(bytes) {
  if (bytes.length < 14) throw new Error('file is too small to be a FIT file');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const warnings = [];
  const messages = [];
  const devMeta = new Map();
  const devApps = new Map();
  let header;
  let sections = 0;
  let pos = 0;

  while (pos + 12 <= bytes.length) {
    const headerSize = bytes[pos];
    if (headerSize < 12 || headerSize > 14) {
      if (sections === 0) throw new Error(`invalid FIT header size ${headerSize}`);
      break;
    }
    const magic = String.fromCharCode(
      bytes[pos + 8],
      bytes[pos + 9],
      bytes[pos + 10],
      bytes[pos + 11],
    );
    if (magic !== '.FIT') {
      if (sections === 0) throw new Error('missing ".FIT" magic in header (not a FIT file)');
      break;
    }
    const protocolVersion = bytes[pos + 1];
    const profileVersion = view.getUint16(pos + 2, true);
    const dataSize = view.getUint32(pos + 4, true);
    const section = {
      headerSize,
      protocolVersion,
      profileVersionMajor: protocolVersion >> 4,
      profileVersionMinor: protocolVersion & 0x0f,
      dataSize,
    };
    if (headerSize >= 14) section.headerCrc = view.getUint16(pos + 12, true);
    if (header === undefined) header = section;

    const dataStart = pos + headerSize;
    const declaredEnd = dataStart + dataSize;
    const dataEnd = Math.min(declaredEnd, bytes.length);
    if (declaredEnd > bytes.length) {
      warnings.push(
        `FIT data section is truncated: header declares ${dataSize} bytes, only ${dataEnd - dataStart} present`,
      );
    }
    if (declaredEnd + 2 <= bytes.length) {
      const stored = view.getUint16(dataEnd, true);
      const computed = crc16(bytes, pos, dataEnd);
      if (stored !== computed) {
        warnings.push(
          `FIT data CRC mismatch (stored 0x${stored.toString(16)}, computed 0x${computed.toString(16)}) — file may be truncated or edited`,
        );
      }
    }

    const defs = {};
    let cursor = dataStart;
    let lastTimestamp = 0;

    while (cursor < dataEnd) {
      const hdr = bytes[cursor];
      cursor += 1;
      const kind_isDefinition = (hdr & 0x80) === 0 && (hdr & 0x40) !== 0;
      const kind_isCompressed = (hdr & 0x80) !== 0 && (hdr & 0x40) === 0;
      const localType = hdr & 0x0f;
      if ((hdr & 0x80) !== 0 && (hdr & 0x40) !== 0) {
        warnings.push(`reserved record header 0x${hdr.toString(16)}; parsing stopped`);
        break;
      }

      if (kind_isDefinition) {
        const isDev = (hdr & 0x20) !== 0;
        cursor += 1; // reserved
        const arch = bytes[cursor];
        cursor += 1;
        const little = arch === 0;
        const globalNum = view.getUint16(cursor, little);
        cursor += 2;
        const nfields = bytes[cursor];
        cursor += 1;
        const fields = [];
        for (let i = 0; i < nfields; i += 1) {
          fields.push({ num: bytes[cursor], size: bytes[cursor + 1], baseType: bytes[cursor + 2] });
          cursor += 3;
        }
        const nativeFields = fields.length;
        if (isDev) {
          const ndev = bytes[cursor];
          cursor += 1;
          for (let i = 0; i < ndev; i += 1) {
            fields.push({
              num: bytes[cursor],
              size: bytes[cursor + 1],
              baseType: bytes[cursor + 2],
              developer: true,
            });
            cursor += 3;
          }
        }
        defs[localType] = { globalNum, little, fields, nativeFields, isDev };
        continue;
      }

      if (kind_isCompressed) {
        const ltime = (hdr >> 5) & 0x07;
        const gnum = hdr & 0x1f;
        const def = defs[gnum];
        if (def === undefined) {
          warnings.push(`data message references undefined local message type ${gnum}; parsing stopped`);
          break;
        }
        let base = Math.floor(lastTimestamp / 32) * 32 + ltime;
        if (ltime < lastTimestamp % 32) base += 32;
        lastTimestamp = base;
        const [raw, next] = readFields(bytes, cursor, def.fields, def.little);
        cursor = next;
        // The compressed header only supplies a timestamp when the definition
        // actually declares field 253 (timestamp).
        if (def.fields.some((field) => field.developer !== true && field.num === 253)) {
          raw[253] = base;
        }
        messages.push(buildMessage(def, raw));
        continue;
      }

      const def = defs[localType];
      if (def === undefined) {
        warnings.push(`data message references undefined local message type ${localType}; parsing stopped`);
        break;
      }
      const [raw, next] = readFields(bytes, cursor, def.fields, def.little);
      cursor = next;
      messages.push(buildMessage(def, raw));
    }

    sections += 1;
    pos = declaredEnd + 2;
  }

  for (const message of messages) {
    if (message.kind === 'field_description') {
      const index = message.values.developer_data_index;
      const num = message.values.field_definition_number;
      if (index === undefined || num === undefined) continue;
      devMeta.set(`${index}:${num}`, {
        developerDataIndex: index,
        fieldDefinitionNumber: num,
        name: message.values.field_name ?? `developer_${index}_${num}`,
        scale: message.values.scale,
        offset: message.values.offset,
        units: message.values.units,
        nativeFieldNum: message.values.native_field_num,
      });
    }
    if (message.kind === 'developer_data_id') {
      const index = message.values.developer_data_index;
      if (index !== undefined) {
        devApps.set(index, {
          manufacturer: message.values.manufacturer_id,
          applicationId: message.values.application_id,
        });
      }
    }
  }

  // Developer values are resolved here, after every description has been seen,
  // so a file that declares its fields late still decodes correctly.
  const devByFieldNum = new Map();
  for (const meta of devMeta.values()) {
    const list = devByFieldNum.get(meta.fieldDefinitionNumber);
    if (list === undefined) devByFieldNum.set(meta.fieldDefinitionNumber, [meta]);
    else list.push(meta);
  }
  const soleIndex = devApps.size === 1 ? [...devApps.keys()][0] : undefined;
  for (const message of messages) {
    if (message.rawDev === undefined) continue;
    const devValues = {};
    const devUnits = {};
    for (const [num, value] of Object.entries(message.rawDev)) {
      const candidates = devByFieldNum.get(Number(num));
      const meta =
        candidates === undefined
          ? undefined
          : (candidates.find((entry) => entry.developerDataIndex === soleIndex) ?? candidates[0]);
      const name = meta?.name ?? `developer_field_${num}`;
      let converted = value;
      if (meta?.scale !== undefined && meta.scale !== 0) converted /= meta.scale;
      if (meta?.offset !== undefined) converted -= meta.offset;
      devValues[name] = converted;
      if (meta?.units !== undefined && meta.units !== '') devUnits[name] = meta.units;
    }
    delete message.rawDev;
    if (Object.keys(devValues).length > 0) {
      message.devValues = devValues;
      if (Object.keys(devUnits).length > 0) message.devUnits = devUnits;
    }
  }

  const counts = {};
  for (const message of messages) counts[message.kind] = (counts[message.kind] ?? 0) + 1;

  return {
    header,
    sections,
    messages,
    counts,
    devFields: [...devMeta.values()].map((meta, index) => ({ index, ...meta })),
    devApps: [...devApps.entries()].map(([index, app]) => ({ index, ...app })),
    warnings,
  };
}

/**
 * Turn one raw field map into a named, unit-converted message.
 * Developer fields are parked in `rawDev` and resolved once every
 * `field_description` message has been read.
 */
function buildMessage(def, raw) {
  const kind = GLOBAL_NAMES[def.globalNum] ?? `unknown_${def.globalNum}`;
  const values = {};
  const units = {};
  const rawDev = {};
  for (const field of def.fields) {
    const value = raw[field.num];
    if (value === undefined) continue;
    if (field.developer === true) {
      rawDev[field.num] = value;
      continue;
    }
    const name = fieldName(kind, field.num);
    const { value: converted, unit } = convert(kind, name, value, FIELD_META);
    values[name] = converted;
    if (unit !== undefined && unit !== '') units[name] = unit;
  }
  return {
    kind,
    globalNum: def.globalNum,
    values,
    units,
    ...(Object.keys(rawDev).length > 0 ? { rawDev } : {}),
  };
}

function enumName(table, value) {
  if (value === undefined) return undefined;
  return table[value];
}

/** Like `enumName`, but keeps the raw number when the profile has no entry. */
function enumNameOrNumber(table, value) {
  if (value === undefined) return undefined;
  return table[value] ?? value;
}

/** Product id 0 means "no product"; an unmapped id is kept as the raw number. */
function productLabel(value) {
  if (value === undefined || value === 0) return undefined;
  return PRODUCT_NAMES[value] ?? value;
}

/** FIT point -> shared point shape, preferring the "enhanced" variants. */
function recordToPoint(values) {
  const point = {};
  if (values.timestamp !== undefined) point.t = values.timestamp;
  if (values.position_lat !== undefined && values.position_long !== undefined) {
    point.lat = Number(values.position_lat.toFixed(6));
    point.lon = Number(values.position_long.toFixed(6));
  }
  const ele = values.enhanced_altitude ?? values.altitude;
  if (ele !== undefined) point.ele = Number(ele.toFixed(2));
  if (values.heart_rate !== undefined) point.hr = values.heart_rate;
  if (values.cadence !== undefined) point.cad = values.cadence;
  const speed = values.enhanced_speed ?? values.speed;
  if (speed !== undefined) point.speed = Number(speed.toFixed(3));
  if (values.power !== undefined) point.power = values.power;
  if (values.temperature !== undefined) point.temp = values.temperature;
  if (values.distance !== undefined) point.dist = Number(values.distance.toFixed(1));
  if (values.grade !== undefined) point.grad = values.grade;
  if (values.gps_accuracy !== undefined) point.hdop = values.gps_accuracy;
  return point;
}

function sessionSummary(values) {
  const out = {
    startTime: values.start_time,
    endTime: values.timestamp,
    sport: enumNameOrNumber(SPORT_NAMES, values.sport),
    subSport: enumNameOrNumber(SUB_SPORT_NAMES, values.sub_sport),
    totalElapsedSeconds: values.total_elapsed_time,
    totalTimerSeconds: values.total_timer_time,
    totalMovingSeconds: values.total_moving_time,
    distanceMeters: values.total_distance,
    calories: values.total_calories,
    avgHeartRate: values.avg_heart_rate,
    maxHeartRate: values.max_heart_rate,
    minHeartRate: values.min_heart_rate,
    avgCadence: values.avg_cadence,
    maxCadence: values.max_cadence,
    avgPower: values.avg_power,
    maxPower: values.max_power,
    normalizedPower: values.normalized_power,
    avgSpeed: values.avg_speed,
    maxSpeed: values.max_speed,
    totalAscent: values.total_ascent,
    totalDescent: values.total_descent,
    avgAltitude: values.avg_altitude,
    minAltitude: values.min_altitude,
    maxAltitude: values.max_altitude,
    avgGrade: values.avg_grade,
    avgTemperature: values.avg_temperature,
    maxTemperature: values.max_temperature,
    avgRespirationRate: values.avg_respiration_rate,
    avgSpo2: values.avg_spo2,
    avgStressLevel: values.avg_stress_level,
    trainingEffect: values.total_training_effect,
    anaerobicTrainingEffect: values.total_anaerobic_training_effect,
    trainingStressScore: values.training_stress_score,
    intensityFactor: values.intensity_factor,
    totalWorkJoules: values.total_work,
    avgStrideLength: values.avg_stride_length,
    avgVerticalOscillation: values.avg_vertical_oscillation,
    avgStanceTime: values.avg_stance_time,
    numLaps: values.num_laps,
    numLengths: values.num_lengths,
  };
  for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key];
  return out;
}

const LAP_FIELD_MAP = {
  startTime: 'start_time',
  endTime: 'timestamp',
  totalElapsedSeconds: 'total_elapsed_time',
  totalTimerSeconds: 'total_timer_time',
  totalMovingSeconds: 'total_moving_time',
  distanceMeters: 'total_distance',
  calories: 'total_calories',
  avgHeartRate: 'avg_heart_rate',
  maxHeartRate: 'max_heart_rate',
  avgCadence: 'avg_cadence',
  maxCadence: 'max_cadence',
  avgPower: 'avg_power',
  maxPower: 'max_power',
  avgSpeed: 'avg_speed',
  maxSpeed: 'max_speed',
  totalAscent: 'total_ascent',
  totalDescent: 'total_descent',
  avgAltitude: 'avg_altitude',
  maxAltitude: 'max_altitude',
  avgGrade: 'avg_grade',
  avgTemperature: 'avg_temperature',
  trigger: 'trigger',
};

function lapSummary(values, index) {
  const out = { index };
  for (const [key, source] of Object.entries(LAP_FIELD_MAP)) {
    if (values[source] !== undefined) out[key] = values[source];
  }
  return out;
}

/**
 * Parse a FIT byte stream into the shared activity structure.
 * @param {Uint8Array} bytes
 * @param {{path?: string, keepMessages?: boolean}} context
 */
export function readFit(bytes, context = {}) {
  const parsed = parseFit(bytes);
  const warnings = [...parsed.warnings];
  const result = {
    container: 'fit',
    path: context.path,
    warnings,
    points: [],
    laps: [],
    events: [],
    waypoints: [],
    routes: [],
    tracks: [],
    activities: [],
    courses: [],
    extras: {},
    totals: {},
    stats: {},
    device: {},
    fit: {
      header: parsed.header,
      sections: parsed.sections,
      counts: parsed.counts,
      developerFields: parsed.devFields,
    },
  };

  const byKind = (kind) => parsed.messages.filter((message) => message.kind === kind);
  const fileId = byKind('file_id')[0];
  if (fileId !== undefined) {
    const type = fileId.values.type;
    result.fileType = enumName(FILE_TYPE_NAMES, type) ?? type;
    result.creator = enumNameOrNumber(MANUFACTURERS, fileId.values.manufacturer);
    result.device.manufacturer = result.creator;
    result.device.product = productLabel(fileId.values.product);
    result.device.productName = fileId.values.product_name;
    result.device.serialNumber = fileId.values.serial_number;
    result.device.createdAt = fileId.values.time_created;
  }

  const deviceInfo = byKind('device_info')[0];
  if (deviceInfo !== undefined) {
    result.device.manufacturer =
      enumNameOrNumber(MANUFACTURERS, deviceInfo.values.manufacturer) ?? result.device.manufacturer;
    result.device.product =
      productLabel(deviceInfo.values.product) ?? result.device.product;
    result.device.serialNumber = deviceInfo.values.serial_number ?? result.device.serialNumber;
    result.device.softwareVersion = deviceInfo.values.software_version;
    result.device.batteryVoltage = deviceInfo.values.battery_voltage;
    result.device.batteryLevel = deviceInfo.values.battery_level;
    result.device.productName = deviceInfo.values.product_name ?? result.device.productName;
  }

  const sportMessage = byKind('sport')[0];
  if (sportMessage !== undefined && sportMessage.values.name !== undefined) {
    result.name = sportMessage.values.name;
  }

  for (const message of byKind('record')) {
    const point = recordToPoint(message.values);
    if (Object.keys(point).length > 0) result.points.push(point);
  }
  for (const [index, message] of byKind('lap').entries()) {
    result.laps.push(lapSummary(message.values, index));
  }
  for (const message of byKind('event')) {
    const event = { t: message.values.timestamp };
    const name = enumName(EVENT_NAMES, message.values.event);
    const type = enumName(EVENT_TYPE_NAMES, message.values.event_type);
    if (name !== undefined) event.event = name;
    if (type !== undefined) event.eventType = type;
    if (message.values.data !== undefined) event.data = message.values.data;
    if (event.t !== undefined || event.event !== undefined) result.events.push(event);
  }

  const sessions = byKind('session');
  const primary = sessions[sessions.length - 1];
  if (primary !== undefined) {
    const summary = sessionSummary(primary.values);
    result.session = summary;
    result.sport = summary.sport;
    result.subSport = summary.subSport;
    result.startTime = summary.startTime;
    result.totals = {
      elapsedSeconds: summary.totalElapsedSeconds,
      timerSeconds: summary.totalTimerSeconds,
      movingSeconds: summary.totalMovingSeconds,
      distanceMeters: summary.distanceMeters,
      calories: summary.calories,
      ascentMeters: summary.totalAscent,
      descentMeters: summary.totalDescent,
    };
    result.stats = {
      avgHeartRate: summary.avgHeartRate,
      maxHeartRate: summary.maxHeartRate,
      avgCadence: summary.avgCadence,
      maxCadence: summary.maxCadence,
      avgSpeed: summary.avgSpeed,
      maxSpeed: summary.maxSpeed,
      avgPower: summary.avgPower,
      maxPower: summary.maxPower,
      avgPaceSecondsPerKm:
        summary.avgSpeed !== undefined && summary.avgSpeed > 0 ? 1000 / summary.avgSpeed : undefined,
    };
    for (const key of Object.keys(result.totals)) {
      if (result.totals[key] === undefined) delete result.totals[key];
    }
    for (const key of Object.keys(result.stats)) {
      if (result.stats[key] === undefined) delete result.stats[key];
    }
  }
  if (sessions.length > 1) {
    result.sessions = sessions.map((message) => sessionSummary(message.values));
    warnings.push(`${sessions.length} session messages in one file; the summary describes the last one`);
  }

  const activityMessage = byKind('activity')[0];
  if (activityMessage !== undefined) {
    result.extras.localTimestamp = activityMessage.values.local_timestamp;
    result.extras.numSessions = activityMessage.values.num_sessions;
  }

  const lengths = byKind('length');
  if (lengths.length > 0) {
    result.lengths = lengths.map((message, index) => ({
      index,
      startTime: message.values.start_time,
      elapsedSeconds: message.values.total_elapsed_time,
      timerSeconds: message.values.total_timer_time,
      strokes: message.values.total_strokes,
      avgSpeed: message.values.avg_speed,
      swimStroke: message.values.swim_stroke,
      calories: message.values.total_calories,
      lengthType: message.values.length_type,
    }));
  }

  const hrv = byKind('hrv')[0];
  if (hrv !== undefined && Array.isArray(hrv.values.time)) {
    result.extras.rrIntervalsSeconds = hrv.values.time;
  }

  if (context.keepMessages === true) result.extras.messages = parsed.messages;

  if (result.points.length === 0) {
    warnings.push(
      result.fileType !== undefined && result.fileType !== 'activity'
        ? `no record messages: this is a FIT "${result.fileType}" file, not a recorded activity`
        : 'no record messages in this FIT file',
    );
  } else if (!result.points.some((point) => point.lat !== undefined)) {
    warnings.push('no GPS coordinates in this FIT file (indoor or GPS-off activity)');
  }
  if (result.startTime === undefined && result.points.length > 0) {
    result.startTime = result.points[0].t;
  }

  return result;
}

/** Cheap sniff: FIT files carry ".FIT" at byte offset 8. */
export function looksLikeFit(bytes) {
  if (bytes.length < 12) return false;
  return (
    bytes[8] === 0x2e && bytes[9] === 0x46 && bytes[10] === 0x49 && bytes[11] === 0x54
  );
}
