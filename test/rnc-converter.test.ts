import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { getConversionProgress, processRncZip } from '../dist/utils/rnc-converter.js';

describe('processRncZip', () => {
  let dir: string;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rnc-converter-'));
  });
  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('stops before extracting when the conversion is cancelled', async () => {
    const zip = path.join(dir, 'charts.zip');
    fs.writeFileSync(zip, 'not read');
    const out = path.join(dir, 'out');
    fs.mkdirSync(out);
    const controller = new AbortController();

    await assert.rejects(
      processRncZip(
        zip,
        out,
        'Cancelled_zip',
        (status) => {
          if (status === 'extracting') {
            controller.abort();
          }
        },
        { signal: controller.signal }
      ),
      { message: 'Conversion cancelled' }
    );
    assert.deepStrictEqual(fs.readdirSync(out), []);
    assert.strictEqual(getConversionProgress('Cancelled_zip')?.message, 'Conversion cancelled');
  });
});
