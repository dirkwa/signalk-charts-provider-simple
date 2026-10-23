/**
 * Geometry for masking charts with OpenStreetMap land polygons: the compact
 * ring encoding the land index stores, the splitting of large polygons when
 * the index is built, and the scanline fill that turns the polygons under a
 * tile into per-pixel land coverage.
 *
 * Everything here is pure and works in Web Mercator metres (EPSG:3857), the
 * projection of both the OSM land polygons and the tiles. It runs in the land
 * index build worker and in the raster workers, never on the event loop.
 *
 * The land-masking approach comes from signalk-noaa-sonar-charts
 * (https://github.com/joelkoz/signalk-noaa-sonar-charts), Copyright Joel
 * Kozikowski, licensed under the Apache License 2.0
 * (https://www.apache.org/licenses/LICENSE-2.0). This version adds interior
 * rings, polygon splitting, thinning to pixel resolution and a pure-JS fill.
 */

/** [minX, minY, maxX, maxY] in Web Mercator metres. */
export type Bbox = [number, number, number, number];

/** One polygon: its rings as flat [x0, y0, x1, y1, ...] arrays, outer ring first. */
export type Rings = Float64Array[];

/** Stored coordinates are whole decimetres: finer than any tile pixel the plugin serves. */
const UNITS_PER_METRE = 10;

function zigzag(n: number): number {
  return n < 0 ? -2 * n - 1 : 2 * n;
}

function unzigzag(n: number): number {
  return n % 2 === 1 ? -(n + 1) / 2 : n / 2;
}

/**
 * Pack a polygon as varints: the ring count, then per ring its point count and
 * the zigzag delta of each coordinate from the previous one. About a fifth of
 * the size of the same rings as 64-bit floats.
 */
export function encodeRings(rings: Rings): Uint8Array {
  const out: number[] = [];
  const put = (value: number): void => {
    let v = value;
    while (v >= 0x80) {
      out.push((v % 0x80) | 0x80);
      v = Math.floor(v / 0x80);
    }
    out.push(v);
  };
  put(rings.length);
  let px = 0;
  let py = 0;
  for (const ring of rings) {
    put(ring.length / 2);
    for (let i = 0; i < ring.length; i += 2) {
      const x = Math.round(ring[i] * UNITS_PER_METRE);
      const y = Math.round(ring[i + 1] * UNITS_PER_METRE);
      put(zigzag(x - px));
      put(zigzag(y - py));
      px = x;
      py = y;
    }
  }
  return Uint8Array.from(out);
}

export function decodeRings(data: Uint8Array): Rings {
  let pos = 0;
  const get = (): number => {
    let value = 0;
    let scale = 1;
    for (;;) {
      if (pos >= data.length) {
        throw new Error('Truncated land polygon');
      }
      const byte = data[pos++];
      value += (byte & 0x7f) * scale;
      if (byte < 0x80) {
        return value;
      }
      scale *= 0x80;
    }
  };
  const ringCount = get();
  const rings: Rings = [];
  let px = 0;
  let py = 0;
  for (let r = 0; r < ringCount; r++) {
    const points = get();
    const ring = new Float64Array(points * 2);
    for (let i = 0; i < points; i++) {
      px += unzigzag(get());
      py += unzigzag(get());
      ring[2 * i] = px / UNITS_PER_METRE;
      ring[2 * i + 1] = py / UNITS_PER_METRE;
    }
    rings.push(ring);
  }
  return rings;
}

export function ringsBbox(rings: Rings): Bbox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i += 2) {
      minX = Math.min(minX, ring[i]);
      maxX = Math.max(maxX, ring[i]);
      minY = Math.min(minY, ring[i + 1]);
      maxY = Math.max(maxY, ring[i + 1]);
    }
  }
  return [minX, minY, maxX, maxY];
}

function pointCount(rings: Rings): number {
  return rings.reduce((n, ring) => n + ring.length / 2, 0);
}

/**
 * Clip one ring to the half-plane on one side of an axis-aligned line
 * (Sutherland–Hodgman). A ring that leaves and re-enters gains edges along
 * the line, which the even-odd fill cancels out.
 */
function clipRing(
  ring: Float64Array,
  axis: 0 | 1,
  value: number,
  keepBelow: boolean
): Float64Array {
  const out: number[] = [];
  const n = ring.length / 2;
  const inside = (i: number): boolean =>
    keepBelow ? ring[2 * i + axis] <= value : ring[2 * i + axis] >= value;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const inI = inside(i);
    const inJ = inside(j);
    if (inI) {
      out.push(ring[2 * i], ring[2 * i + 1]);
    }
    if (inI !== inJ) {
      const a = ring[2 * i + axis];
      const b = ring[2 * j + axis];
      const t = (value - a) / (b - a);
      const x = ring[2 * i] + t * (ring[2 * j] - ring[2 * i]);
      const y = ring[2 * i + 1] + t * (ring[2 * j + 1] - ring[2 * i + 1]);
      out.push(axis === 0 ? value : x, axis === 1 ? value : y);
    }
  }
  return Float64Array.from(out);
}

function clipRings(rings: Rings, axis: 0 | 1, value: number, keepBelow: boolean): Rings {
  return rings
    .map((ring) => clipRing(ring, axis, value, keepBelow))
    .filter((ring) => ring.length >= 6);
}

/**
 * Split a polygon into pieces of at most `maxPoints` points by halving its
 * box, so the rows a tile reads stay small however large the landmass. OSM's
 * full-detail set is already split this way; its simplified set has whole
 * continents as one polygon. Rings are clipped one by one, which keeps holes
 * correct under the even-odd fill.
 */
export function splitPolygon(rings: Rings, maxPoints: number, depth = 0): Rings[] {
  if (pointCount(rings) <= maxPoints || depth >= 16) {
    return rings.length > 0 ? [rings] : [];
  }
  const [minX, minY, maxX, maxY] = ringsBbox(rings);
  const axis: 0 | 1 = maxX - minX >= maxY - minY ? 0 : 1;
  const mid = axis === 0 ? (minX + maxX) / 2 : (minY + maxY) / 2;
  return [
    ...splitPolygon(clipRings(rings, axis, mid, true), maxPoints, depth + 1),
    ...splitPolygon(clipRings(rings, axis, mid, false), maxPoints, depth + 1)
  ];
}

/**
 * A polygon without the vertices within `tolerance` metres of the last one
 * kept, for a coarser copy; rings left too small to have an area are dropped.
 */
export function thinRings(rings: Rings, tolerance: number): Rings {
  const thinned: Rings = [];
  for (const ring of rings) {
    const out: number[] = [];
    const count = ring.length / 2;
    for (let i = 0; i < count; i++) {
      const x = ring[2 * i];
      const y = ring[2 * i + 1];
      const last = out.length - 2;
      if (
        i === 0 ||
        i === count - 1 ||
        Math.abs(x - out[last]) >= tolerance ||
        Math.abs(y - out[last + 1]) >= tolerance
      ) {
        out.push(x, y);
      }
    }
    if (out.length >= 8) {
      thinned.push(Float64Array.from(out));
    }
  }
  return thinned;
}

/** Vertices closer than this, in pixels, to the last one kept are dropped before filling. */
export const THIN_PIXELS = 0.25;

/**
 * A ring in tile pixel coordinates, without the vertices that fall within
 * THIN_PIXELS of the previous one kept, so the fill costs what the tile's
 * pixels can show rather than what the coastline holds. Null when nothing
 * of a ring's area could show.
 */
function toPixels(ring: Float64Array, bbox: Bbox, size: number): Float64Array | null {
  const scale = size / (bbox[2] - bbox[0]);
  const out = new Float64Array(ring.length);
  let n = 0;
  let lastX = NaN;
  let lastY = NaN;
  const count = ring.length / 2;
  for (let i = 0; i < count; i++) {
    const x = (ring[2 * i] - bbox[0]) * scale;
    const y = (bbox[3] - ring[2 * i + 1]) * scale;
    if (
      i === 0 ||
      i === count - 1 ||
      Math.abs(x - lastX) >= THIN_PIXELS ||
      Math.abs(y - lastY) >= THIN_PIXELS
    ) {
      out[n++] = x;
      out[n++] = y;
      lastX = x;
      lastY = y;
    }
  }
  return n >= 6 ? out.subarray(0, n) : null;
}

/** Sub-scanlines per pixel row: four give smooth coastlines without a full 2-D supersample. */
const SUBSAMPLES = 4;

/**
 * How much of each pixel of a `size`×`size` tile covering `bbox` is land,
 * 0–255, row by row. Each polygon is filled under the even-odd rule, so its
 * holes stay water, and the land is the union of the polygons: OSM's split
 * pieces overlap slightly, and pieces that only touch must not leave a seam.
 */
export function landCoverage(polygons: readonly Rings[], bbox: Bbox, size: number): Uint8Array {
  // Edges as [x at top, top y, bottom y, dx/dy, polygon], top < bottom in pixels.
  const edges: number[][] = [];
  polygons.forEach((rings, polygon) => {
    for (const ring of rings) {
      const px = toPixels(ring, bbox, size);
      if (!px) {
        continue;
      }
      const n = px.length / 2;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        let x0 = px[2 * i];
        let y0 = px[2 * i + 1];
        let x1 = px[2 * j];
        let y1 = px[2 * j + 1];
        if (y0 === y1) {
          continue;
        }
        if (y0 > y1) {
          [x0, y0, x1, y1] = [x1, y1, x0, y0];
        }
        if (y1 <= 0 || y0 >= size) {
          continue;
        }
        edges.push([x0, y0, y1, (x1 - x0) / (y1 - y0), polygon]);
      }
    }
  });
  edges.sort((a, b) => a[1] - b[1]);

  const coverage = new Uint8Array(size * size);
  const row = new Float64Array(size + 1);
  let active: number[][] = [];
  let next = 0;
  const weight = 1 / SUBSAMPLES;
  for (let py = 0; py < size; py++) {
    row.fill(0);
    for (let s = 0; s < SUBSAMPLES; s++) {
      const y = py + (s + 0.5) / SUBSAMPLES;
      while (next < edges.length && edges[next][1] <= y) {
        active.push(edges[next++]);
      }
      active = active.filter((e) => e[2] > y);
      for (const [start, end] of landSpans(active, y)) {
        const a = Math.max(0, start);
        const b = Math.min(size, end);
        if (b <= a) {
          continue;
        }
        const ia = Math.floor(a);
        const ib = Math.floor(b);
        if (ia === ib) {
          row[ia] += (b - a) * weight;
          continue;
        }
        row[ia] += (ia + 1 - a) * weight;
        for (let i = ia + 1; i < ib; i++) {
          row[i] += weight;
        }
        if (ib < size) {
          row[ib] += (b - ib) * weight;
        }
      }
    }
    const base = py * size;
    for (let i = 0; i < size; i++) {
      coverage[base + i] = Math.min(255, Math.round(row[i] * 255));
    }
  }
  return coverage;
}

/**
 * Where one sub-scanline at `y` crosses land: each polygon's own even-odd
 * spans, merged across polygons.
 */
function landSpans(active: readonly number[][], y: number): [number, number][] {
  const byPolygon = new Map<number, number[]>();
  for (const e of active) {
    if (e[1] <= y) {
      const xs = byPolygon.get(e[4]) ?? [];
      xs.push(e[0] + (y - e[1]) * e[3]);
      byPolygon.set(e[4], xs);
    }
  }
  const spans: [number, number][] = [];
  for (const xs of byPolygon.values()) {
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      if (xs[k + 1] > xs[k]) {
        spans.push([xs[k], xs[k + 1]]);
      }
    }
  }
  spans.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last && span[0] <= last[1]) {
      last[1] = Math.max(last[1], span[1]);
    } else {
      merged.push(span);
    }
  }
  return merged;
}
