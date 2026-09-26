/**
 * TIME dimensions of online weather layers: finding a layer's dimension in
 * a WMS or WMTS capabilities document, and turning it into the `time` block
 * a Signal K chart resource carries (the Plotter Extensions `charts.time`
 * convention), clamped to the window the catalog entry asks for.
 *
 * Services write their timelines in several forms, all handled here:
 * - an explicit list of instants (NOAA NCEP, nowCOAST, NDFD, ECCC GDPS);
 * - `start/end/period` (ECCC radar, EUMETSAT, DWD);
 * - a comma-separated list of such intervals, with gaps (NASA GIBS);
 * - interval ends of `now`, `current` or `latest`, meaning the present.
 * Some services advertise years of frames, so frames are only ever
 * generated inside the requested window.
 */

/** The `time` block of a chart resource, as a chart plotter reads it. */
export interface ChartTimeBlock {
  /** The service has a live/latest frame, so "no TIME" is a valid request. */
  current: boolean;
  from?: string;
  to?: string;
  /** Milliseconds between frames, when the timeline is a regular grid. */
  step?: number;
  /** The instants on offer, when the timeline is not a regular grid. */
  values?: string[];
}

export interface TimeWindow {
  /** `observation` frames run up to now; `forecast` frames run from now on. */
  kind: string;
  /** ISO 8601 duration; defaults per kind when absent. */
  window?: string;
}

interface Interval {
  start: number;
  end: number;
  /** 0 for a lone instant. */
  period: number;
}

/** A parsed dimension: explicit instants, or regular intervals. */
export type TimeExtent =
  { kind: 'list'; instants: number[] } | { kind: 'intervals'; intervals: Interval[] };

// More frames than this is never useful to a plotter's time slider, and
// bounds the work for tiny periods (PT1S) over long ranges.
export const MAX_FRAMES = 400;

const DEFAULT_WINDOW: Record<string, string> = {
  observation: 'PT3H',
  forecast: 'P5D'
};

/**
 * An ISO 8601 duration in milliseconds (weeks, days, hours, minutes,
 * seconds; years and months are approximated, and never appear in
 * practice). Null when it isn't a duration or is zero.
 */
export function parseIsoDuration(text: string): number | null {
  const t = text.trim();
  const m =
    /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
      t
    );
  if (!m || t === 'P' || t.endsWith('T')) {
    return null;
  }
  const [, y, mo, w, d, h, mi, s] = m.map((v) => (v ? Number(v) : 0));
  const ms =
    ((((y ?? 0) * 365 + (mo ?? 0) * 30 + (w ?? 0) * 7 + (d ?? 0)) * 24 + (h ?? 0)) * 60 +
      (mi ?? 0)) *
      60000 +
    (s ?? 0) * 1000;
  return ms > 0 ? ms : null;
}

function parseInstant(text: string, now: number): number | null {
  const t = text.trim();
  if (/^(now|current|latest|present)$/i.test(t)) {
    return now;
  }
  // A timestamp without a zone is UTC in these documents; Date.parse would
  // read it in the server's local zone.
  const zoned = /T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(t) ? `${t}Z` : t;
  const ms = Date.parse(zoned);
  return Number.isFinite(ms) ? ms : null;
}

/** Parse a dimension's text content. Null when nothing in it is usable. */
export function parseTimeExtent(text: string, now: number): TimeExtent | null {
  const parts = text
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '');
  if (parts.length === 0) {
    return null;
  }
  if (parts.some((p) => p.includes('/'))) {
    const intervals: Interval[] = [];
    for (const part of parts) {
      const [a, b, p] = part.split('/');
      const start = a !== undefined ? parseInstant(a, now) : null;
      if (b === undefined) {
        if (start !== null) {
          intervals.push({ start, end: start, period: 0 });
        }
        continue;
      }
      const end = parseInstant(b, now);
      const period = p !== undefined ? parseIsoDuration(p) : null;
      if (start !== null && end !== null && period !== null && end >= start) {
        intervals.push({ start, end, period });
      }
    }
    return intervals.length > 0 ? { kind: 'intervals', intervals } : null;
  }
  const instants = parts.map((p) => parseInstant(p, now)).filter((v): v is number => v !== null);
  return instants.length > 0
    ? { kind: 'list', instants: [...new Set(instants)].sort((x, y) => x - y) }
    : null;
}

/** ISO 8601 without milliseconds when they are zero, as services list them. */
export function formatInstant(ms: number): string {
  return new Date(ms).toISOString().replace('.000Z', 'Z');
}

function windowSpan(window: TimeWindow): number {
  return (
    parseIsoDuration(window.window ?? '') ??
    parseIsoDuration(DEFAULT_WINDOW[window.kind] ?? 'PT3H') ??
    3 * 3600000
  );
}

/** The frames of one interval inside [lower, upper], at most `limit`. */
function intervalFrames(
  iv: Interval,
  lower: number,
  upper: number,
  limit: number,
  newestFirst: boolean
): number[] {
  if (iv.period === 0) {
    return iv.start >= lower && iv.start <= upper ? [iv.start] : [];
  }
  // Frames stay on the interval's own grid (start + n × period): services
  // such as ECCC and GIBS only answer times that fall exactly on it.
  const firstN = Math.max(0, Math.ceil((lower - iv.start) / iv.period));
  const lastN = Math.floor((Math.min(iv.end, upper) - iv.start) / iv.period);
  if (lastN < firstN) {
    return [];
  }
  const count = Math.min(limit, lastN - firstN + 1);
  const from = newestFirst ? lastN - count + 1 : firstN;
  const frames: number[] = [];
  for (let n = from; n < from + count; n++) {
    frames.push(iv.start + n * iv.period);
  }
  return frames;
}

/** Every frame the extent offers inside [lower, upper], at most `limit`. */
function framesIn(
  extent: TimeExtent,
  lower: number,
  upper: number,
  limit: number,
  newestFirst: boolean
): number[] {
  const all =
    extent.kind === 'list'
      ? extent.instants.filter((t) => t >= lower && t <= upper)
      : extent.intervals.flatMap((iv) => intervalFrames(iv, lower, upper, limit, newestFirst));
  const sorted = [...new Set(all)].sort((a, b) => a - b);
  return newestFirst ? sorted.slice(-limit) : sorted.slice(0, limit);
}

/**
 * The window of frames a plotter should offer, nearest now first:
 * - observation: the last `window` up to now, plus any nowcast frames the
 *   service adds after now (DWD radar), within the same span;
 * - forecast: from the frame in force now up to `window` ahead.
 * Null when no frame falls inside the window (a stale or broken service).
 */
export function buildTimeBlock(
  extent: TimeExtent,
  window: TimeWindow,
  now: number
): ChartTimeBlock | null {
  const span = windowSpan(window);
  let values: number[];
  if (window.kind === 'forecast') {
    // The frame in force is the latest one at or before now.
    const [inForce] = framesIn(extent, Number.NEGATIVE_INFINITY, now, 1, true);
    values = framesIn(extent, inForce ?? now, now + span, MAX_FRAMES, false);
  } else {
    values = framesIn(extent, now - span, now + span, MAX_FRAMES, true);
  }
  if (values.length === 0) {
    return null;
  }
  const from = values[0] ?? 0;
  const to = values[values.length - 1] ?? 0;

  // One regular interval is sent as from/to/step, which keeps the frequent
  // resource updates small; anything else lists its frames.
  const single =
    extent.kind === 'intervals' && extent.intervals.length === 1 ? extent.intervals[0] : undefined;
  if (single && single.period > 0 && values.length > 1) {
    return {
      current: true,
      from: formatInstant(from),
      to: formatInstant(to),
      step: single.period
    };
  }
  return {
    current: true,
    from: formatInstant(from),
    to: formatInstant(to),
    values: values.map(formatInstant)
  };
}

function decodeXmlText(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The TIME dimension text in one layer's own scope, or null. */
function dimensionInScope(scope: string): string | null {
  // WMS 1.3 <Dimension name="time">…</Dimension> or 1.1.1 <Extent>; a
  // self-closed declaration (<Dimension name="time" …/>) has no values.
  const wms =
    /<(?:\w+:)?(Dimension|Extent)\b([^>]*\bname\s*=\s*["']time["'][^>]*?)(?<!\/)>([\s\S]*?)<\/(?:\w+:)?\1>/i.exec(
      scope
    );
  if (wms?.[3] !== undefined) {
    return decodeXmlText(wms[3]);
  }
  // WMTS: <Dimension><ows:Identifier>time</ows:Identifier> … <Value>…</Value>
  for (const dim of scope.matchAll(/<Dimension>([\s\S]*?)<\/Dimension>/g)) {
    const body = dim[1] ?? '';
    if (/<(?:\w+:)?Identifier>\s*time\s*<\/(?:\w+:)?Identifier>/i.test(body)) {
      const values = [...body.matchAll(/<Value>([\s\S]*?)<\/Value>/g)].map((v) =>
        decodeXmlText(v[1] ?? '')
      );
      if (values.length > 0) {
        return values.join(',');
      }
    }
  }
  return null;
}

/**
 * The text of `layer`'s TIME dimension in a WMS or WMTS capabilities
 * document, or null.
 *
 * A targeted scan rather than a full XML parse: some documents are several
 * megabytes (NASA GIBS), and this runs on small boat computers. A layer's
 * dimension follows its name before any child layer starts.
 *
 * An exact name match wins. Failing that, a bare name matches the layer in
 * any workspace (GeoServer `ws:name`), and a workspace-qualified name
 * matches its bare form (per-layer virtual services drop the prefix) but
 * never the same name in another workspace.
 */
export function findLayerTimeDimension(xml: string, layer: string): string | null {
  const colon = layer.indexOf(':');
  const bare = colon >= 0 ? layer.slice(colon + 1) : layer;
  const exact = escapeRegExp(layer);
  const fallback = colon >= 0 ? escapeRegExp(bare) : `(?:[\\w.-]+:)?${escapeRegExp(bare)}`;
  for (const pattern of [exact, fallback]) {
    const nameRe = new RegExp(
      `<(?:\\w+:)?(?:Name|Identifier)>\\s*${pattern}\\s*</(?:\\w+:)?(?:Name|Identifier)>`,
      'g'
    );
    for (const match of xml.matchAll(nameRe)) {
      const after = xml.slice((match.index ?? 0) + match[0].length);
      // Stop at the next layer, so a child's or sibling's dimension is
      // never mistaken for this one.
      const boundary = after.search(/<(?:\w+:)?Layer[\s>]|<\/(?:\w+:)?Layer>/);
      const found = dimensionInScope(boundary >= 0 ? after.slice(0, boundary) : after);
      if (found !== null) {
        return found;
      }
    }
  }
  return null;
}

/** The GetCapabilities URL for a chart whose entry doesn't give one. */
export function capabilitiesUrlFor(serviceUrl: string, type: 'WMS' | 'WMTS'): string {
  const url = new URL(serviceUrl);
  url.searchParams.set('service', type);
  url.searchParams.set('request', 'GetCapabilities');
  if (type === 'WMS') {
    url.searchParams.set('version', '1.3.0');
  }
  return url.href;
}
