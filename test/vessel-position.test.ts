import { describe, it } from 'node:test';
import assert from 'node:assert';

import { readVesselPosition } from '../dist/utils/vessel-position.js';

describe('readVesselPosition', () => {
  const keyWest = { latitude: 24.55, longitude: -81.8 };

  it('reads the node getSelfPath returns, or a bare value', () => {
    assert.deepStrictEqual(readVesselPosition({ value: keyWest, $source: 'x' }), keyWest);
    assert.deepStrictEqual(readVesselPosition(keyWest), keyWest);
  });

  it('rejects missing, partial and non-numeric positions', () => {
    for (const bad of [
      undefined,
      null,
      { value: null },
      { value: { latitude: 24.55 } },
      { value: { latitude: '24.55', longitude: -81.8 } },
      { value: { latitude: Number.NaN, longitude: -81.8 } },
      { value: { latitude: 91, longitude: -81.8 } },
      { value: { latitude: 24.55, longitude: 181 } }
    ]) {
      assert.strictEqual(readVesselPosition(bad), null, JSON.stringify(bad));
    }
  });
});
