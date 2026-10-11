/**
 * dsh-gps-reader — gives the agent direct read access to GPX, TCX and FIT
 * activity files.
 *
 * Registers one tool, `activity_read`, which sniffs the container format,
 * decodes the track (positions, heart rate, cadence, power, temperature,
 * laps and events) and returns a normalised summary plus derived metrics:
 * distance, pace, moving time, elevation change, per-kilometre splits and
 * heart-rate zone distribution.
 */

import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';

import { readGpx, looksLikeGpx } from './gpx.js';
import { readTcx, looksLikeTcx } from './tcx.js';
import { readFit, looksLikeFit } from './fit.js';
import { normalize, renderSummary } from './model.js';

export const name = 'gps-reader';

export const Config = z.object({
  /** Refuse to load files larger than this (bytes). */
  maxBytes: z.number().default(64 * 1024 * 1024),
  /** Upper bound on points emitted when `points` is `full`. */
  maxPoints: z.number().default(500),
  /** Whether per-kilometre splits are computed by default. */
  splits: z.boolean().default(true),
});

export const inject = ['tools', 'fs'];

const FORMATS = ['auto', 'gpx', 'tcx', 'fit'];
const POINTS_MODES = ['none', 'summary', 'full'];

const EXTENSION_FORMATS = { gpx: 'gpx', tcx: 'tcx', fit: 'fit' };

function extensionOf(displayPath) {
  const match = /\.([a-z0-9]+)$/i.exec(displayPath ?? '');
  return match === null ? undefined : match[1].toLowerCase();
}

/** Decide which reader to use from the bytes first, the extension second. */
function detectFormat(bytes, displayPath, requested) {
  const text = bytes.length > 0 ? new TextDecoder('utf-8').decode(bytes.subarray(0, 8192)) : '';
  const sniffed = looksLikeFit(bytes)
    ? 'fit'
    : looksLikeGpx(text)
      ? 'gpx'
      : looksLikeTcx(text)
        ? 'tcx'
        : undefined;
  const byExtension = EXTENSION_FORMATS[extensionOf(displayPath) ?? ''];

  if (requested !== 'auto') {
    if (sniffed !== undefined && sniffed !== requested) {
      return {
        format: requested,
        warning: `file content looks like ${sniffed.toUpperCase()} but format=${requested} was requested; parsed as ${requested.toUpperCase()}`,
      };
    }
    return { format: requested };
  }
  if (sniffed !== undefined) return { format: sniffed };
  if (byExtension !== undefined) {
    return {
      format: byExtension,
      warning: `could not recognise the file content; parsed as ${byExtension.toUpperCase()} because of the .${byExtension} extension`,
    };
  }
  throw new Error(
    'could not detect the file format: not a FIT container and the text has no <gpx> or <TrainingCenterDatabase> root; pass format="gpx"|"tcx"|"fit" to force one',
  );
}

function decodeUtf8(bytes, displayPath) {
  let text = new TextDecoder('utf-8').decode(bytes);
  // Strip a UTF-8 BOM so the XML reader sees `<` on the first byte.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.trimStart().startsWith('\u0000')) {
    throw new Error(
      `${displayPath} is not readable as text; if it is a FIT file check that format="fit"`,
    );
  }
  return text;
}

export function apply(ctx, config) {
  const maxBytes = config?.maxBytes ?? 64 * 1024 * 1024;
  const defaultMaxPoints = config?.maxPoints ?? 500;
  const defaultSplits = config?.splits ?? true;

  const tool = defineTool({
    name: 'activity_read',
    description:
      'Read a GPS/sport activity file (GPX, TCX or FIT) and return a normalised summary: ' +
      'distance, elapsed and moving time, pace/speed, elevation gain and loss, heart rate, ' +
      'cadence, power, per-kilometre splits and the laps, events and waypoints the file ' +
      'contains. Positions and timestamps are used to derive metrics the file omits, so a ' +
      'plain GPX track still reports distance and pace. Set points="summary" or points="full" ' +
      'to also get the per-sample series.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description:
          'Path to the .gpx, .tcx or .fit file. Relative paths resolve against the session working directory.',
      },
      format: {
        type: 'string',
        enum: FORMATS,
        default: 'auto',
        description: 'Container format. "auto" sniffs the content and falls back to the extension.',
      },
      points: {
        type: 'string',
        enum: POINTS_MODES,
        default: 'none',
        description:
          '"none" (default) reports no sample series; "summary" reports ~60 time buckets; "full" reports the cleaned samples, downsampled to maxPoints.',
      },
      maxPoints: {
        type: 'number',
        default: defaultMaxPoints,
        description: 'Maximum number of samples returned when points="full".',
      },
      splits: {
        type: 'boolean',
        default: defaultSplits,
        description: 'Compute per-kilometre splits (default true).',
      },
      json: {
        type: 'boolean',
        default: false,
        description: 'Return the complete structured payload as JSON instead of the prose summary.',
      },
    },
    output: {
      schema: { type: 'json' },
      render(args, value) {
        if (value?.ok !== true) {
          return [{ type: 'text', text: `activity_read failed: ${value?.error ?? 'unknown error'}` }];
        }
        const text = args?.json === true ? JSON.stringify(value.payload, null, 2) : value.text;
        return [{ type: 'text', text }];
      },
    },
    isConcurrencySafe() {
      return true;
    },
    async execute(args, exec) {
      const requestedFormat = FORMATS.includes(args.format) ? args.format : 'auto';
      const pointsMode = POINTS_MODES.includes(args.points) ? args.points : 'none';
      const maxPoints = Number.isFinite(args.maxPoints) && args.maxPoints > 0
        ? Math.min(Math.floor(args.maxPoints), 20000)
        : defaultMaxPoints;

      const target = await ctx.fs.resolve(args.path, {
        cwd: exec.agent?.session?.header?.cwd,
        signal: exec.signal,
      });
      const info = await ctx.fs.stat(target, exec.signal);
      if (info === undefined) {
        throw new Error(`file not found: ${target.displayPath}`);
      }
      if (info.type !== 'file') {
        throw new Error(`not a regular file: ${target.displayPath} (type: ${info.type})`);
      }
      if (info.size !== undefined && info.size > maxBytes) {
        throw new Error(
          `file is ${info.size} bytes, above the configured limit of ${maxBytes} bytes; raise the plugin's maxBytes config to read it`,
        );
      }

      let bytes;
      try {
        bytes = await ctx.fs.readBytes(target, exec.signal, maxBytes);
      } catch (error) {
        if (error?.code === 'FS_TOO_LARGE') {
          throw new Error(
            `file is larger than the configured limit of ${maxBytes} bytes; raise the plugin's maxBytes config to read it`,
          );
        }
        throw error;
      }

      const detected = detectFormat(bytes, target.displayPath, requestedFormat);
      const extraWarnings = detected.warning !== undefined ? [detected.warning] : [];

      let activity;
      if (detected.format === 'fit') {
        activity = readFit(bytes, { path: target.displayPath });
      } else {
        const source = decodeUtf8(bytes, target.displayPath);
        activity =
          detected.format === 'gpx'
            ? readGpx(source, { path: target.displayPath })
            : readTcx(source, { path: target.displayPath });
      }
      activity.warnings = [...extraWarnings, ...(activity.warnings ?? [])];

      const payload = normalize(activity, {
        points: pointsMode,
        maxPoints,
        splits: args.splits !== false,
      });

      const pointsNote =
        payload.points === undefined
          ? 'sample series omitted; call again with points="summary" or points="full" for per-sample data'
          : payload.pointsSampled === true
            ? `sample series downsampled to ${payload.points.length} of ${payload.pointCount} points`
            : `sample series: ${payload.points.length} entries`;
      const text = renderSummary(payload, { pointsNote });

      return {
        ok: true,
        tool: 'activity_read',
        format: detected.format,
        file: target.displayPath,
        sizeBytes: info.size ?? bytes.length,
        text,
        payload,
      };
    },
  });

  ctx.tools.register(tool);
}
