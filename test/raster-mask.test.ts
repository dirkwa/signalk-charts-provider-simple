import { describe, it } from 'node:test';
import assert from 'node:assert';

import { PNG } from 'pngjs';

import { encodeRings } from '../dist/utils/land-geometry.js';
import { maskRasterTile, SHORE_MARGIN_PX, type MaskJob } from '../dist/utils/raster-mask.js';
import { rect } from './land-fixtures.js';

const SIZE = 256;
// A square of land covering pixels 64–192 of a tile spanning 0–1000 m.
const LAND = encodeRings([Float64Array.from(rect(250, 250, 750, 750).flat())]);

function opaqueTile(): Uint8Array {
  const png = new PNG({ width: SIZE, height: SIZE });
  png.data.fill(255);
  return PNG.sync.write(png);
}

function alphas(mode: MaskJob['mode'], polygons = [LAND]): Uint8Array {
  const result = maskRasterTile({
    raw: opaqueTile(),
    polygons,
    bbox: [0, 0, 1000, 1000],
    margin: mode === 'land-only' ? SHORE_MARGIN_PX : 0,
    mode
  });
  assert.strictEqual(result.kind, 'masked');
  const img = PNG.sync.read(Buffer.from(result.kind === 'masked' ? result.data : []));
  return Uint8Array.from({ length: SIZE * SIZE }, (_, i) => img.data[4 * i + 3]);
}

describe('maskRasterTile', () => {
  it('keeps the water for Water only and the land for Land only, as complements', () => {
    const water = alphas('water-only');
    const land = alphas('land-only');
    const at = (a: Uint8Array, x: number, y: number): number => a[y * SIZE + x];
    assert.deepStrictEqual([at(water, 128, 128), at(land, 128, 128)], [0, 255], 'inland');
    assert.deepStrictEqual([at(water, 10, 10), at(land, 10, 10)], [255, 0], 'at sea');
    // Away from the shore margin they add up to the whole tile.
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const nearShore =
          x >= 64 - SHORE_MARGIN_PX - 1 &&
          x <= 192 + SHORE_MARGIN_PX &&
          y >= 64 - SHORE_MARGIN_PX - 1 &&
          y <= 192 + SHORE_MARGIN_PX &&
          !(
            x > 64 + SHORE_MARGIN_PX &&
            x < 191 - SHORE_MARGIN_PX &&
            y > 64 + SHORE_MARGIN_PX &&
            y < 191 - SHORE_MARGIN_PX
          );
        if (!nearShore) {
          assert.strictEqual(at(water, x, y) + at(land, x, y), 255, `${String(x)},${String(y)}`);
        }
      }
    }
  });

  it('pulls Land only back from the shore by the margin', () => {
    const land = alphas('land-only');
    const row = (x: number): number => land[128 * SIZE + x];
    assert.strictEqual(row(64 + SHORE_MARGIN_PX - 1), 0, 'within the margin: cut away');
    assert.strictEqual(row(64 + SHORE_MARGIN_PX + 1), 255, 'past the margin: kept');
    assert.strictEqual(row(191 - SHORE_MARGIN_PX + 1), 0);
    assert.strictEqual(row(191 - SHORE_MARGIN_PX - 1), 255);
  });

  it('does not pull land back from a tile edge it carries on across', () => {
    const edge = (fromX: number): number => {
      const land = encodeRings([Float64Array.from(rect(fromX, 250, 500, 750).flat())]);
      const result = maskRasterTile({
        raw: opaqueTile(),
        polygons: [land],
        bbox: [0, 0, 1000, 1000],
        margin: SHORE_MARGIN_PX,
        mode: 'land-only'
      });
      assert.strictEqual(result.kind, 'masked');
      const img = PNG.sync.read(Buffer.from(result.kind === 'masked' ? result.data : []));
      return img.data[(128 * SIZE + 0) * 4 + 3];
    };
    assert.strictEqual(edge(-100), 255, 'land that runs on into the next tile reaches the edge');
    assert.strictEqual(edge(0), 0, 'a coastline on the edge itself is pulled back');
  });

  it('serves no Land only tile where there is no land, and the plain tile where all is land', () => {
    const job = (polygons: Uint8Array[], mode: MaskJob['mode']): MaskJob => ({
      raw: opaqueTile(),
      polygons,
      bbox: [0, 0, 1000, 1000],
      margin: SHORE_MARGIN_PX,
      mode
    });
    assert.strictEqual(maskRasterTile(job([], 'land-only')).kind, 'empty');
    const everywhere = encodeRings([Float64Array.from(rect(-500, -500, 1500, 1500).flat())]);
    assert.strictEqual(maskRasterTile(job([everywhere], 'land-only')).kind, 'raw');
    assert.strictEqual(maskRasterTile(job([everywhere], 'water-only')).kind, 'empty');
  });
});
