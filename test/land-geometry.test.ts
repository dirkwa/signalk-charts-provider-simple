import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  decodeRings,
  encodeRings,
  landCoverage,
  splitPolygon,
  type Bbox,
  type Rings
} from '../dist/utils/land-geometry.js';
import { readShapefilePolygons } from '../dist/utils/land-shapefile.js';
import { rect, shapefile, type TestRing } from './land-fixtures.js';

const ring = (points: TestRing): Float64Array => Float64Array.from(points.flat());

function maxDifference(a: Uint8Array, b: Uint8Array): number {
  let max = 0;
  for (let i = 0; i < a.length; i++) {
    max = Math.max(max, Math.abs(a[i] - b[i]));
  }
  return max;
}
const TILE: Bbox = [0, 0, 1000, 1000];

/** How much of one pixel is land, 0-255. */
function landAt(coverage: Uint8Array, size: number, px: number, py: number): number {
  return coverage[py * size + px];
}

describe('land polygon encoding', () => {
  it('round-trips rings to a tenth of a metre', () => {
    const rings: Rings = [
      ring([
        [-20037508.34, 85.05],
        [1234.56, -98765.43],
        [20037508.34, 0.04]
      ]),
      ring([
        [1, 2],
        [3, 4],
        [5, 6]
      ])
    ];
    const decoded = decodeRings(encodeRings(rings));
    assert.strictEqual(decoded.length, 2);
    rings.forEach((r, i) => {
      r.forEach((v, j) => {
        assert.ok(Math.abs(decoded[i][j] - v) <= 0.05, `${String(v)} vs ${String(decoded[i][j])}`);
      });
    });
  });

  it('refuses truncated data', () => {
    const data = encodeRings([ring(rect(0, 0, 10, 10))]);
    assert.throws(() => decodeRings(data.subarray(0, data.length - 2)));
  });
});

describe('landCoverage', () => {
  for (const size of [256, 512]) {
    it(`fills a square and nothing else at ${String(size)} px`, () => {
      const coverage = landCoverage([[ring(rect(250, 250, 750, 750))]], TILE, size);
      const q = size / 4;
      assert.strictEqual(landAt(coverage, size, size / 2, size / 2), 255);
      assert.strictEqual(landAt(coverage, size, q + 1, q + 1), 255);
      assert.strictEqual(landAt(coverage, size, q - 2, size / 2), 0);
      assert.strictEqual(landAt(coverage, size, size / 2, 3 * q + 1), 0);
      const filled = coverage.reduce((n, c) => n + (c >= 128 ? 1 : 0), 0);
      assert.ok(Math.abs(filled - (size / 2) ** 2) <= size * 2, String(filled));
    });
  }

  it('keeps water enclosed by land, such as a lagoon', () => {
    const atoll = [ring(rect(100, 100, 900, 900)), ring(rect(300, 300, 700, 700).reverse())];
    const coverage = landCoverage([atoll], TILE, 256);
    assert.strictEqual(landAt(coverage, 256, 128, 128), 0, 'lagoon stays water');
    assert.strictEqual(landAt(coverage, 256, 50, 128), 255, 'reef is land');
    assert.strictEqual(landAt(coverage, 256, 5, 5), 0, 'open sea stays water');
  });

  it('fills a polygon that runs past the tile edge', () => {
    const coverage = landCoverage([[ring(rect(-5000, -5000, 500, 5000))]], TILE, 256);
    assert.strictEqual(landAt(coverage, 256, 0, 0), 255);
    assert.strictEqual(landAt(coverage, 256, 120, 255), 255);
    assert.strictEqual(landAt(coverage, 256, 140, 128), 0);
  });

  it('shades the pixels a coastline crosses, for a smooth edge', () => {
    // An edge through the middle of pixel column 64.
    const coverage = landCoverage([[ring(rect(0, 0, (64.5 / 256) * 1000, 1000))]], TILE, 256);
    const edge = landAt(coverage, 256, 64, 100);
    assert.ok(edge > 96 && edge < 160, String(edge));
  });

  it('leaves no gap where two pieces of land overlap, as OSM split pieces do', () => {
    const coverage = landCoverage(
      [[ring(rect(0, 0, 520, 1000))], [ring(rect(480, 0, 1000, 1000))]],
      TILE,
      256
    );
    assert.ok(coverage.every((c) => c === 255));
  });

  it('leaves no seam where two pieces of land meet', () => {
    const coverage = landCoverage(
      [[ring(rect(0, 0, 500, 1000))], [ring(rect(500, 0, 1000, 1000))]],
      TILE,
      256
    );
    assert.ok(coverage.every((c) => c === 255));
  });

  it('fills the same pixels when the coastline has far more points than pixels', () => {
    // A wavy coastline, then the same line with every edge cut into 200 points.
    const coarse: TestRing = [];
    for (let i = 0; i <= 50; i++) {
      coarse.push([i * 20, 500 + 150 * Math.sin(i / 3)]);
    }
    coarse.push([1000, 0], [0, 0], coarse[0]);
    const fine: TestRing = [];
    for (let i = 0; i + 1 < coarse.length; i++) {
      for (let k = 0; k < 200; k++) {
        const t = k / 200;
        fine.push([
          coarse[i][0] + t * (coarse[i + 1][0] - coarse[i][0]),
          coarse[i][1] + t * (coarse[i + 1][1] - coarse[i][1])
        ]);
      }
    }
    fine.push(coarse[0]);
    const a = landCoverage([[ring(coarse)]], TILE, 256);
    const b = landCoverage([[ring(fine)]], TILE, 256);
    // Coastline pixels may shade a little differently; none changes much.
    assert.ok(maxDifference(a, b) <= 64, String(maxDifference(a, b)));
  });

  it('fills a tile over a detailed coastline within a time budget', () => {
    // 200,000 points, like the largest simplified continent, under one tile.
    const detailed: TestRing = [];
    const n = 200_000;
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n;
      const r = 400 + 30 * Math.sin(a * 997);
      detailed.push([500 + r * Math.cos(a), 500 + r * Math.sin(a)]);
    }
    detailed.push(detailed[0]);
    const start = performance.now();
    const coverage = landCoverage([[ring(detailed)]], TILE, 512);
    const ms = performance.now() - start;
    assert.strictEqual(landAt(coverage, 512, 256, 256), 255);
    assert.ok(ms < 2000, `${String(Math.round(ms))} ms`);
  });
});

describe('splitPolygon', () => {
  it('splits a large polygon into pieces that fill the same pixels', () => {
    const big: TestRing = [];
    for (let i = 0; i < 5000; i++) {
      const a = (2 * Math.PI * i) / 5000;
      big.push([500 + 400 * Math.cos(a), 500 + 400 * Math.sin(a)]);
    }
    big.push(big[0]);
    const hole = ring(rect(450, 450, 550, 550).reverse());
    const whole: Rings = [ring(big), hole];
    const pieces = splitPolygon(whole, 1000);
    assert.ok(pieces.length > 1);
    for (const piece of pieces) {
      assert.ok(piece.reduce((n, r) => n + r.length / 2, 0) <= 1000);
    }
    const a = landCoverage([whole], TILE, 256);
    const b = landCoverage(pieces, TILE, 256);
    // Coastline pixels may shade a little differently; none changes much.
    assert.ok(maxDifference(a, b) <= 64, String(maxDifference(a, b)));
    assert.strictEqual(landAt(b, 256, 128, 128), 0, 'the hole stays water');
  });

  it('keeps a small polygon whole', () => {
    const rings: Rings = [ring(rect(0, 0, 1, 1))];
    assert.deepStrictEqual(splitPolygon(rings, 1000), [rings]);
  });
});

describe('readShapefilePolygons', () => {
  const polygons: TestRing[][] = [
    [rect(0, 0, 10, 10), rect(2, 2, 4, 4).reverse()],
    [],
    [rect(20, 20, 30, 30)]
  ];

  async function* inChunks(data: Buffer, size: number): AsyncGenerator<Uint8Array> {
    for (let i = 0; i < data.length; i += size) {
      yield data.subarray(i, i + size);
      await Promise.resolve();
    }
  }

  for (const chunk of [7, 64, 100_000]) {
    it(`reads each polygon with its holes, in ${String(chunk)}-byte chunks`, async () => {
      const read: Rings[] = [];
      for await (const polygon of readShapefilePolygons(inChunks(shapefile(polygons), chunk))) {
        read.push(polygon);
      }
      assert.strictEqual(read.length, 2, 'the null shape is skipped');
      assert.strictEqual(read[0].length, 2);
      assert.deepStrictEqual([...read[0][1]], rect(2, 2, 4, 4).reverse().flat());
      assert.deepStrictEqual([...read[1][0]], rect(20, 20, 30, 30).flat());
    });
  }

  it('refuses a file that ends part way through a record', async () => {
    const data = shapefile(polygons);
    const read: Rings[] = [];
    await assert.rejects(async () => {
      for await (const polygon of readShapefilePolygons(inChunks(data.subarray(0, 150), 64))) {
        read.push(polygon);
      }
    });
    assert.strictEqual(read.length, 0);
  });
});
