/**
 * Minimal, dependency-free XML reader.
 *
 * Scope: element-oriented, machine-generated documents — GPX 1.0/1.1 and TCX
 * (Garmin TrainingCenterDatabase v1/v2). It is deliberately NOT a general XML
 * processor: no DTD validation, no external entities, no namespace resolution
 * beyond splitting `prefix:local`, and mixed content collapses into one text
 * string per element.
 *
 * Robustness choices that matter for real activity files:
 *   - comments, processing instructions and DOCTYPE (including an internal
 *     subset) are skipped rather than choking the parser;
 *   - CDATA contributes raw text;
 *   - `>` inside a quoted attribute value does not terminate a tag;
 *   - mismatched close tags pop to the nearest matching ancestor instead of
 *     aborting, so a single bad element cannot lose the whole track.
 */

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  copy: '\u00a9',
  reg: '\u00ae',
  deg: '\u00b0',
  plusmn: '\u00b1',
  micro: '\u00b5',
  middot: '\u00b7',
  times: '\u00d7',
  hellip: '\u2026',
  ndash: '\u2013',
  mdash: '\u2014',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201c',
  rdquo: '\u201d',
  bull: '\u2022',
};

const ENTITY_RE = /&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g;

/** Decode the XML entities that actually appear in track files. */
export function decodeEntities(text) {
  if (text.indexOf('&') < 0) return text;
  return text.replace(ENTITY_RE, (match, body) => {
    if (body.charCodeAt(0) === 35 /* # */) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    const named = NAMED_ENTITIES[body];
    return named === undefined ? match : named;
  });
}

/** Local part of a possibly prefixed name (`gpxtpx:hr` -> `hr`). */
export function localName(name) {
  const colon = name.indexOf(':');
  return colon < 0 ? name : name.slice(colon + 1);
}

/** Prefix part of a possibly prefixed name (`gpxtpx:hr` -> `gpxtpx`). */
export function prefixOf(name) {
  const colon = name.indexOf(':');
  return colon < 0 ? '' : name.slice(0, colon);
}

/** Index of the `>` closing a tag that starts at `from`, ignoring quoted `>`. */
function findTagEnd(source, from) {
  let quote = 0;
  for (let i = from; i < source.length; i += 1) {
    const code = source.charCodeAt(i);
    if (quote !== 0) {
      if (code === quote) quote = 0;
      continue;
    }
    if (code === 34 /* " */ || code === 39 /* ' */) {
      quote = code;
      continue;
    }
    if (code === 62 /* > */) return i;
  }
  return -1;
}

const ATTR_RE = /([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** Split a tag body into its name and attributes. */
function parseTagBody(body) {
  let i = 0;
  while (i < body.length && !/\s/.test(body[i])) i += 1;
  const rawName = body.slice(0, i);
  const attrs = {};
  ATTR_RE.lastIndex = i;
  let match = ATTR_RE.exec(body);
  while (match !== null) {
    const value = match[2] !== undefined ? match[2] : match[3];
    attrs[match[1]] = decodeEntities(value ?? '');
    match = ATTR_RE.exec(body);
  }
  return { rawName, attrs };
}

function makeNode(rawName, attrs) {
  return {
    name: rawName,
    local: localName(rawName),
    prefix: prefixOf(rawName),
    attrs,
    children: [],
    text: '',
  };
}

/**
 * Parse an XML document into a lightweight element tree.
 * @param {string} source - decoded document text.
 * @returns {object|null} the document element, or null when nothing parsed.
 */
export function parseXml(source) {
  if (typeof source !== 'string' || source.length === 0) return null;
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const stack = [];
  let root = null;
  let pos = 0;

  while (pos < text.length) {
    const lt = text.indexOf('<', pos);
    if (lt < 0) break;
    if (lt > pos && stack.length > 0) {
      stack[stack.length - 1].text += decodeEntities(text.slice(pos, lt));
    }
    pos = lt;

    if (text.startsWith('<!--', pos)) {
      const end = text.indexOf('-->', pos + 4);
      pos = end < 0 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', pos)) {
      const end = text.indexOf(']]>', pos + 9);
      const raw = text.slice(pos + 9, end < 0 ? text.length : end);
      if (stack.length > 0) stack[stack.length - 1].text += raw;
      pos = end < 0 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith('<?', pos)) {
      const end = text.indexOf('?>', pos + 2);
      pos = end < 0 ? text.length : end + 2;
      continue;
    }
    if (text.startsWith('<!', pos)) {
      // DOCTYPE, possibly with an internal subset in brackets.
      let depth = 0;
      let end = -1;
      for (let i = pos + 2; i < text.length; i += 1) {
        const ch = text[i];
        if (ch === '[') depth += 1;
        else if (ch === ']') depth -= 1;
        else if (ch === '>' && depth <= 0) {
          end = i;
          break;
        }
      }
      pos = end < 0 ? text.length : end + 1;
      continue;
    }

    const gt = findTagEnd(text, pos + 1);
    if (gt < 0) break;
    const inner = text.slice(pos + 1, gt);
    pos = gt + 1;

    if (inner.charCodeAt(0) === 47 /* / */) {
      const closing = localName(inner.slice(1).trim());
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i].local === closing) {
          stack.length = i;
          break;
        }
      }
      continue;
    }

    const selfClosing = inner.endsWith('/');
    const { rawName, attrs } = parseTagBody(selfClosing ? inner.slice(0, -1) : inner);
    if (rawName.length === 0) continue;
    const node = makeNode(rawName, attrs);
    if (stack.length > 0) stack[stack.length - 1].children.push(node);
    else if (root === null) root = node;
    if (!selfClosing) stack.push(node);
  }

  return root;
}

/* ---------------------------------------------------------------- reading */

const lower = (value) => (typeof value === 'string' ? value.toLowerCase() : '');

/** First direct child with the given local name (case-insensitive). */
export function child(node, local) {
  if (node === null || node === undefined) return undefined;
  const want = lower(local);
  for (const item of node.children) if (lower(item.local) === want) return item;
  return undefined;
}

/** All direct children with the given local name (case-insensitive). */
export function children(node, local) {
  if (node === null || node === undefined) return [];
  const want = lower(local);
  return node.children.filter((item) => lower(item.local) === want);
}

/** Walk a chain of local names, e.g. path(lap, 'track', 'trackpoint'). */
export function path(node, ...locals) {
  let current = node;
  for (const step of locals) {
    current = child(current, step);
    if (current === undefined) return undefined;
  }
  return current;
}

/** Trimmed text of a node, or of a named descendant chain. */
export function text(node, ...locals) {
  const target = locals.length > 0 ? path(node, ...locals) : node;
  if (target === undefined || target === null) return undefined;
  const value = target.text.trim();
  return value.length === 0 ? undefined : value;
}

/** Trimmed text parsed as a finite number, else undefined. */
export function num(node, ...locals) {
  const value = text(node, ...locals);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Attribute value by exact name, falling back to a case-insensitive match. */
export function attr(node, name) {
  if (node === null || node === undefined) return undefined;
  const direct = node.attrs[name];
  if (direct !== undefined) return direct;
  const want = lower(name);
  for (const key of Object.keys(node.attrs)) if (lower(key) === want) return node.attrs[key];
  return undefined;
}

/** Attribute parsed as a finite number, else undefined. */
export function attrNum(node, name) {
  const value = attr(node, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Iterate every element at or below `node` (iterative: no stack overflow). */
export function walk(node, visit) {
  if (node === null || node === undefined) return;
  const stack = [node];
  while (stack.length > 0) {
    const current = stack.pop();
    visit(current);
    for (const item of current.children) stack.push(item);
  }
}

/**
 * Flatten a subtree into `{ localName: value }` leaf pairs.
 * Used for the open-ended `<extensions>` blocks in GPX and TCX, where every
 * producer invents its own element names. Prefixed leaves register under both
 * their local and their full name; the first value wins so a dedicated element
 * is not overwritten by a namespaced twin.
 */
export function flattenLeaves(node, into = {}) {
  if (node === null || node === undefined) return into;
  walk(node, (item) => {
    if (item.children.length > 0) return;
    const value = item.text.trim();
    if (value.length === 0) return;
    if (into[item.local] === undefined) into[item.local] = value;
    if (item.prefix.length > 0 && into[item.name] === undefined) into[item.name] = value;
  });
  return into;
}
