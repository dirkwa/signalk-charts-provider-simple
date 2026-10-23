import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Value } from 'typebox/value';

import {
  DIRECT_SOURCE_ADAPTERS,
  EncDirectSourcesFileSchema,
  checkDirectSources,
  parseUsaceIencCatalog,
  usaceDateTime,
  type EncDirectSourcesFile
} from '../dist/catalog/enc-direct-sources.js';
import { archiveJobs, encSources } from '../dist/catalog/build-enc-index.js';
import type { ChartcatalogsIndex } from '../dist/catalog/merged-catalog-schema.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const CHARTCATALOGS: ChartcatalogsIndex = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'catalog/chartcatalogs-index.json'), 'utf8')
) as ChartcatalogsIndex;

const USACE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<IENCU37ProductCatalog>
<Header><title>IENC U37 Product Catalog</title><date_created>10/16/2026</date_created></Header>
<Cell>
  <name>U37AG001</name>
  <location><from>Pittsburgh, PA</from><to>Allegheny Lock No. 8</to></location>
  <river_name>Allegheny</river_name>
  <edition>22.16</edition>
  <s57_file>
    <location> https://ienccloud.us/ienc/products/files/u37/ienc_s57/U37AG001.zip </location>
    <date_posted>06/30/2026</date_posted>
    <time_posted>9:40</time_posted>
  </s57_file>
</Cell>
<Cell>
  <name>U37XX001</name>
  <river_name>Nowhere</river_name>
  <s57_file><location></location><date_posted>01/02/2026</date_posted></s57_file>
</Cell>
<Cell>
  <name>U37OH001</name>
  <s57_file>
    <location>https://ienccloud.us/ienc/products/files/u37/ienc_s57/U37OH001.zip</location>
    <date_posted>1/2/2026</date_posted>
    <time_posted></time_posted>
  </s57_file>
</Cell>
</IENCU37ProductCatalog>`;

describe('direct ENC sources', () => {
  const shipped = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'catalog/enc-direct-sources.json'), 'utf8')
  ) as unknown;

  it('ships a valid list whose ids no other source uses', () => {
    assert.ok(Value.Check(EncDirectSourcesFileSchema, shipped));
    const ids = encSources(CHARTCATALOGS).map((s) => s.id);
    assert.deepStrictEqual(checkDirectSources(shipped as EncDirectSourcesFile, ids), []);
  });

  it('has an adapter for every format the schema allows', () => {
    for (const source of (shipped as EncDirectSourcesFile).sources) {
      assert.strictEqual(typeof DIRECT_SOURCE_ADAPTERS[source.format], 'function', source.id);
    }
  });

  it('rejects unknown fields and formats', () => {
    const entry = {
      id: 'X',
      label: 'X',
      format: 'usace-ienc-product-catalog',
      catalog: 'https://example.com/c.xml'
    };
    assert.ok(Value.Check(EncDirectSourcesFileSchema, { sources: [entry] }));
    assert.ok(!Value.Check(EncDirectSourcesFileSchema, { sources: [{ ...entry, extra: 1 }] }));
    assert.ok(!Value.Check(EncDirectSourcesFileSchema, { sources: [{ ...entry, format: 'x' }] }));
    assert.ok(
      !Value.Check(EncDirectSourcesFileSchema, {
        sources: [{ ...entry, catalog: 'http://example.com/c.xml' }]
      })
    );
  });

  it('refuses a duplicate id, or one another source already has', () => {
    const entry = {
      id: 'X',
      label: 'X',
      format: 'usace-ienc-product-catalog' as const,
      catalog: 'https://example.com/c.xml'
    };
    assert.deepStrictEqual(
      checkDirectSources({ sources: [entry, entry, { ...entry, id: 'noaa' }] }, []),
      ['X: duplicate id', 'noaa: id already used by another ENC source']
    );
    assert.deepStrictEqual(
      checkDirectSources({ sources: [{ ...entry, id: 'AT_IENC_Catalog' }] }, ['AT_IENC_Catalog']),
      ['AT_IENC_Catalog: id already used by another ENC source']
    );
  });
});

describe('USACE IENC product catalog', () => {
  it('turns its date and time into a sortable timestamp', () => {
    assert.strictEqual(usaceDateTime('06/30/2026', '9:40'), '2026-06-30T09:40:00Z');
    assert.strictEqual(usaceDateTime('1/2/2026', ''), '2026-01-02T00:00:00Z');
    assert.strictEqual(usaceDateTime('2026-01-02', ''), '');
  });

  it('lists each cell with an S-57 download, titled by its river and stretch', async () => {
    assert.deepStrictEqual(await parseUsaceIencCatalog(USACE_XML), [
      {
        url: 'https://ienccloud.us/ienc/products/files/u37/ienc_s57/U37AG001.zip',
        version: '2026-06-30T09:40:00Z',
        title: 'Allegheny: Pittsburgh, PA to Allegheny Lock No. 8'
      },
      {
        url: 'https://ienccloud.us/ienc/products/files/u37/ienc_s57/U37OH001.zip',
        version: '2026-01-02T00:00:00Z',
        title: 'U37OH001'
      }
    ]);
  });

  it('refuses a document that is not such a catalog', async () => {
    await assert.rejects(parseUsaceIencCatalog('<Other/>'), /not a USACE IENC product catalog/);
  });
});

describe('direct sources in the index build', () => {
  const direct = [
    {
      id: 'USACE_IENC',
      label: 'US Inland Rivers ENC (USACE)',
      format: 'usace-ienc-product-catalog' as const,
      catalog: 'https://ienccloud.us/ienc/products/catalog/IENCU37ProductsCatalog.xml'
    }
  ];

  it('lists a direct source with its catalog', () => {
    const source = encSources(CHARTCATALOGS, direct).find((s) => s.id === 'USACE_IENC');
    assert.deepStrictEqual(source, {
      id: 'USACE_IENC',
      label: 'US Inland Rivers ENC (USACE)',
      kind: 'direct',
      catalog: 'https://ienccloud.us/ienc/products/catalog/IENCU37ProductsCatalog.xml'
    });
  });

  it('makes jobs from the archives its catalog lists', async () => {
    const archives = await parseUsaceIencCatalog(USACE_XML);
    const jobs = archiveJobs(
      encSources({}, direct),
      [],
      new Map([['USACE_IENC', [...archives, { ...archives[0], version: '2025-01-01T00:00:00Z' }]]])
    );
    assert.deepStrictEqual(
      jobs.map((j) => [j.source, j.url.slice(-12), j.version]),
      [
        ['USACE_IENC', 'U37AG001.zip', '2026-06-30T09:40:00Z'],
        ['USACE_IENC', 'U37OH001.zip', '2026-01-02T00:00:00Z']
      ]
    );
  });
});
