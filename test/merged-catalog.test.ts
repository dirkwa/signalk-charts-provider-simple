import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Value } from '@sinclair/typebox/value';

import { parseChartcatalogsXml } from '../dist/catalog/chartcatalogs-xml.js';
import {
  buildMergedCatalog,
  computeContentHash,
  decidePublish,
  publishBlockers,
  readPublishedState,
  type BuildInputs,
  type ChartcatalogsFile
} from '../dist/catalog/build-merged-catalog.js';
import {
  ChartcatalogsIndexSchema,
  MergedCatalogSchema,
  OnlineChartTemporalSchema,
  OnlineChartsSourceFileSchema,
  checkChartcatalogsIndex,
  checkOnlineChartEntry,
  type ChartcatalogsIndex,
  type ChartcatalogsIndexEntry,
  type MergedCatalog,
  type OnlineChartEntry,
  type OnlineChartsSourceFile
} from '../dist/catalog/merged-catalog-schema.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(relative: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relative), 'utf8'));
}

function errors(schema: Parameters<typeof Value.Errors>[0], value: unknown): string[] {
  return [...Value.Errors(schema, value)].map((e) => `${e.path}: ${e.message}`);
}

const RNC_XML = `<?xml version="1.0" ?>
<RncProductCatalogChartCatalogs>
  <Header><title>Test RNC Charts</title><date_created>2026-09-25</date_created><date_valid>2026-09-25</date_valid></Header>
  <chart>
    <number>T-1</number>
    <title>Test chart one</title>
    <format>Sailing Chart</format>
    <zipfile_location>
      https://example.com/t1.zip
    </zipfile_location>
    <zipfile_datetime_iso8601>2026-01-01T00:00:00Z</zipfile_datetime_iso8601>
  </chart>
  <chart>
    <number>T-2</number>
    <title>No download location</title>
  </chart>
  <chart>
    <number>   </number>
    <zipfile_location>https://example.com/blank-number.zip</zipfile_location>
  </chart>
</RncProductCatalogChartCatalogs>`;

const ENC_XML = `<?xml version="1.0" ?>
<EncProductCatalogcellCatalogs>
  <Header><title>Test ENC Cells</title></Header>
  <cell>
    <name>XX1TEST</name>
    <lname>Test cell</lname>
    <zipfile_location>https://example.com/xx1test.zip</zipfile_location>
    <zipfile_datetime_iso8601>2026-02-01T00:00:00Z</zipfile_datetime_iso8601>
  </cell>
  <cell>
    <name>XX2FTP</name>
    <zipfile_location>ftp://example.com/xx2.zip</zipfile_location>
  </cell>
</EncProductCatalogcellCatalogs>`;

const RNC_FACETS: ChartcatalogsIndexEntry = {
  label: 'Test Raster Charts',
  category: 'navigation',
  format: 'rnc',
  regions: ['xx'],
  bbox: [-10, -10, 10, 10]
};

const INDEX: ChartcatalogsIndex = {
  'XX_RNC_Catalog.xml': RNC_FACETS,
  'GONE_Catalog.xml': {
    label: 'Removed upstream',
    category: 'navigation',
    format: 'enc',
    regions: ['xx'],
    bbox: [0, 0, 1, 1]
  }
};

function onlineEntry(overrides: Partial<OnlineChartEntry> = {}): OnlineChartEntry {
  return {
    id: 'test-radar',
    name: 'Test Radar',
    description: 'A test radar layer.',
    category: 'weather',
    regions: ['us-conus'],
    bbox: [-130, 20, -60, 55],
    provider: 'Test',
    attribution: 'Test',
    license: 'Public domain',
    licenseUrl: 'https://example.com/license',
    chart: { type: 'WMS', url: 'https://example.com/ows', layers: ['radar'] },
    temporal: { kind: 'observation', refreshInterval: 300000, window: 'PT2H' },
    ...overrides
  };
}

async function sampleFiles(): Promise<ChartcatalogsFile[]> {
  return [
    { file: 'XX_RNC_Catalog.xml', parsed: await parseChartcatalogsXml(RNC_XML) },
    { file: 'YY_ENC_Catalog.xml', parsed: await parseChartcatalogsXml(ENC_XML) }
  ];
}

async function inputs(overrides: Partial<BuildInputs> = {}): Promise<BuildInputs> {
  return {
    chartcatalogs: await sampleFiles(),
    chartcatalogsCommit: 'abc123',
    index: INDEX,
    online: { charts: [onlineEntry()] },
    repo: 'owner/repo',
    now: new Date('2026-09-25T12:00:00Z'),
    ...overrides
  };
}

/** `count` copies of the sample RNC catalog under distinct file names. */
async function manyFiles(count: number): Promise<ChartcatalogsFile[]> {
  const parsed = await parseChartcatalogsXml(RNC_XML);
  return Array.from({ length: count }, (_, i) => ({
    file: `F${String(i).padStart(2, '0')}_RNC_Catalog.xml`,
    parsed
  }));
}

/** The sample files with `XX_RNC_Catalog.xml` replaced by `replace(parsed)`. */
async function withBrokenRnc(
  replace: (f: ChartcatalogsFile) => ChartcatalogsFile
): Promise<ChartcatalogsFile[]> {
  return (await sampleFiles()).map((f) => (f.file === 'XX_RNC_Catalog.xml' ? replace(f) : f));
}

function withoutHash(catalog: MergedCatalog): Omit<MergedCatalog, 'contentHash'> {
  const { contentHash: _hash, ...rest } = catalog;
  return rest;
}

describe('catalog source files shipped in the repo', () => {
  it('online-charts.json is valid', () => {
    const file = readJson('catalog/online-charts.json');
    assert.deepStrictEqual(errors(OnlineChartsSourceFileSchema, file), []);
    const { charts } = file as OnlineChartsSourceFile;
    assert.deepStrictEqual(charts.flatMap(checkOnlineChartEntry), []);
    const ids = charts.map((c) => c.id);
    assert.strictEqual(new Set(ids).size, ids.length, 'online chart ids must be unique');
  });

  it('chartcatalogs-index.json is valid', () => {
    const file = readJson('catalog/chartcatalogs-index.json');
    assert.deepStrictEqual(errors(ChartcatalogsIndexSchema, file), []);
    assert.deepStrictEqual(checkChartcatalogsIndex(file as ChartcatalogsIndex), []);
  });

  it('source schemas reject unknown fields, catching typos', () => {
    const typo = { charts: [{ ...onlineEntry(), descripton: 'typo' }] };
    assert.notDeepStrictEqual(errors(OnlineChartsSourceFileSchema, typo), []);
  });
});

describe('temporal window duration', () => {
  const accepts = (window: string) =>
    Value.Check(OnlineChartTemporalSchema, { kind: 'observation', refreshInterval: 60000, window });

  it('accepts day/hour/minute durations', () => {
    for (const w of ['P1D', 'PT2H', 'PT30M', 'P1DT2H30M', 'P5D', 'PT1H15M']) {
      assert.ok(accepts(w), w);
    }
  });

  it('rejects empty or malformed durations', () => {
    for (const w of ['P', 'PT', 'P1DT', 'PT5', '2H', 'P1W']) {
      assert.ok(!accepts(w), w);
    }
  });
});

describe('parseChartcatalogsXml', () => {
  it('trims wrapped values and drops charts that cannot be downloaded or tracked', async () => {
    const { header, charts } = await parseChartcatalogsXml(RNC_XML);
    assert.strictEqual(header.title, 'Test RNC Charts');
    assert.deepStrictEqual(
      charts.map((c) => c.number),
      ['T-1']
    );
    assert.strictEqual(charts[0]?.zipfile_location, 'https://example.com/t1.zip');
  });

  it('reads ENC cell catalogs', async () => {
    const { charts } = await parseChartcatalogsXml(ENC_XML);
    assert.deepStrictEqual(charts[0], {
      number: 'XX1TEST',
      title: 'Test cell',
      format: '',
      zipfile_location: 'https://example.com/xx1test.zip',
      zipfile_datetime_iso8601: '2026-02-01T00:00:00Z'
    });
  });

  it('rejects documents that are not chartcatalogs catalogs', async () => {
    await assert.rejects(parseChartcatalogsXml('<rss><channel/></rss>'), /Unexpected XML root/);
  });
});

describe('buildMergedCatalog', () => {
  it('produces a schema-valid catalog with facets from the index', async () => {
    const { catalog } = buildMergedCatalog(await inputs());
    assert.deepStrictEqual(errors(MergedCatalogSchema, catalog), []);
    const rnc = catalog.chartcatalogs.find((c) => c.file === 'XX_RNC_Catalog.xml');
    assert.strictEqual(rnc?.label, 'Test Raster Charts');
    assert.strictEqual(rnc.format, 'rnc');
    assert.strictEqual(rnc.use, 'download');
    assert.strictEqual(rnc.indexed, true);
    assert.deepStrictEqual(rnc.bbox, [-10, -10, 10, 10]);
  });

  it('publishes files missing from the index without location facets', async () => {
    const { catalog, unindexed } = buildMergedCatalog(await inputs());
    assert.deepStrictEqual(unindexed, ['YY_ENC_Catalog.xml']);
    const enc = catalog.chartcatalogs.find((c) => c.file === 'YY_ENC_Catalog.xml');
    assert.strictEqual(enc?.indexed, false);
    assert.strictEqual(enc.label, 'Test ENC Cells');
    assert.strictEqual(enc.bbox, undefined);
  });

  it('drops charts whose download location is not http(s), and reports them', async () => {
    const { catalog, droppedCharts } = buildMergedCatalog(await inputs());
    const enc = catalog.chartcatalogs.find((c) => c.file === 'YY_ENC_Catalog.xml');
    assert.deepStrictEqual(
      enc?.charts.map((c) => c.number),
      ['XX1TEST']
    );
    assert.deepStrictEqual(droppedCharts, ['YY_ENC_Catalog.xml XX2FTP']);
  });

  it('reports index entries chartcatalogs no longer has', async () => {
    const { staleIndexEntries } = buildMergedCatalog(await inputs());
    assert.deepStrictEqual(staleIndexEntries, ['GONE_Catalog.xml']);
  });

  it('derives use and format for online charts', async () => {
    const { catalog } = buildMergedCatalog(await inputs());
    assert.strictEqual(catalog.online[0]?.use, 'stream');
    assert.strictEqual(catalog.online[0].format, 'wms');
  });

  it('points issue links at the publishing repo', async () => {
    const { catalog } = buildMergedCatalog(await inputs());
    assert.strictEqual(
      catalog.sources.online.issues,
      'https://github.com/owner/repo/issues/new?template=catalog-problem.yml'
    );
  });

  it('rejects duplicate online ids and WMS entries without a layer', async () => {
    const dup = await inputs({ online: { charts: [onlineEntry(), onlineEntry()] } });
    assert.throws(() => buildMergedCatalog(dup), /duplicate id/);
    const noLayer = onlineEntry({ chart: { type: 'WMS', url: 'https://example.com/ows' } });
    const bad = await inputs({ online: { charts: [noLayer] } });
    assert.throws(() => buildMergedCatalog(bad), /must name their layer/);
  });

  it('rejects an index entry with an inverted bbox', async () => {
    const inverted: ChartcatalogsIndexEntry = { ...RNC_FACETS, bbox: [-10, 10, 10, -10] };
    const bad = await inputs({ index: { ...INDEX, 'XX_RNC_Catalog.xml': inverted } });
    assert.throws(() => buildMergedCatalog(bad), /bbox south must be below north/);
  });

  it('skips a broken file that was never published', async () => {
    const files = (await sampleFiles()).map((f) =>
      f.file === 'YY_ENC_Catalog.xml' ? { ...f, parsed: null } : f
    );
    const { catalog, skipped } = buildMergedCatalog(await inputs({ chartcatalogs: files }));
    assert.deepStrictEqual(skipped, ['YY_ENC_Catalog.xml']);
    assert.ok(!catalog.chartcatalogs.some((c) => c.file === 'YY_ENC_Catalog.xml'));
  });

  describe('when a published catalog exists', () => {
    async function previous() {
      const { catalog } = buildMergedCatalog(await inputs());
      return { catalog, entries: readPublishedState(catalog, null).chartcatalogs };
    }

    it('carries forward a file that fails to parse upstream', async () => {
      const prev = await previous();
      const files = await withBrokenRnc((f) => ({ ...f, parsed: null }));
      const result = buildMergedCatalog(
        await inputs({ chartcatalogs: files, previous: prev.entries })
      );
      assert.deepStrictEqual(result.carriedForward, ['XX_RNC_Catalog.xml']);
      assert.strictEqual(result.catalog.contentHash, prev.catalog.contentHash);
    });

    it('carries forward a file that suddenly has no charts', async () => {
      const prev = await previous();
      const files = await withBrokenRnc((f) =>
        f.parsed ? { ...f, parsed: { ...f.parsed, charts: [] } } : f
      );
      const result = buildMergedCatalog(
        await inputs({ chartcatalogs: files, previous: prev.entries })
      );
      assert.deepStrictEqual(result.carriedForward, ['XX_RNC_Catalog.xml']);
      assert.strictEqual(result.catalog.contentHash, prev.catalog.contentHash);
    });

    it('reports a published file that chartcatalogs no longer has', async () => {
      const prev = await previous();
      const files = (await sampleFiles()).filter((f) => f.file !== 'XX_RNC_Catalog.xml');
      const result = buildMergedCatalog(
        await inputs({ chartcatalogs: files, previous: prev.entries })
      );
      assert.deepStrictEqual(result.removedUpstream, ['XX_RNC_Catalog.xml']);
      assert.ok(!result.catalog.chartcatalogs.some((c) => c.file === 'XX_RNC_Catalog.xml'));
    });

    it('applies current index facets to a carried-forward entry', async () => {
      const prev = await previous();
      const files = await withBrokenRnc((f) => ({ ...f, parsed: null }));
      const index = { ...INDEX, 'XX_RNC_Catalog.xml': { ...RNC_FACETS, label: 'Renamed' } };
      const { catalog } = buildMergedCatalog(
        await inputs({ chartcatalogs: files, index, previous: prev.entries })
      );
      assert.strictEqual(
        catalog.chartcatalogs.find((c) => c.file === 'XX_RNC_Catalog.xml')?.label,
        'Renamed'
      );
    });
  });
});

describe('checkOnlineChartEntry', () => {
  it('rejects temporal tile layers', () => {
    const tiles = onlineEntry({
      chart: { type: 'tilelayer', url: 'https://example.com/{z}/{x}/{y}.png' }
    });
    assert.match(checkOnlineChartEntry(tiles).join(), /only WMS\/WMTS charts can be temporal/);
  });

  it('rejects layers on non-OGC charts', () => {
    const style = onlineEntry({
      chart: { type: 'mapstyleJSON', url: 'https://example.com/style.json', layers: ['x'] },
      temporal: undefined
    });
    assert.match(checkOnlineChartEntry(style).join(), /layers only apply to WMS\/WMTS/);
  });

  it('rejects an inverted zoom range and an inverted bbox', () => {
    const bad = onlineEntry({
      chart: {
        type: 'WMS',
        url: 'https://example.com/ows',
        layers: ['x'],
        minzoom: 10,
        maxzoom: 4
      },
      bbox: [0, 50, 10, 40]
    });
    const problems = checkOnlineChartEntry(bad).join();
    assert.match(problems, /minzoom is greater than maxzoom/);
    assert.match(problems, /bbox south must be below north/);
  });
});

describe('computeContentHash', () => {
  it('ignores timestamps and the upstream commit', async () => {
    const a = buildMergedCatalog(await inputs()).catalog;
    const b = buildMergedCatalog(
      await inputs({ now: new Date('2026-09-26T00:00:00Z'), chartcatalogsCommit: 'def456' })
    ).catalog;
    const bumpedHeader = {
      ...withoutHash(b),
      chartcatalogs: b.chartcatalogs.map((c) => ({
        ...c,
        header: { ...c.header, dateCreated: '2030-01-01', dateValid: '2030-01-01' }
      }))
    };
    assert.strictEqual(a.contentHash, b.contentHash);
    assert.strictEqual(computeContentHash(bumpedHeader), a.contentHash);
  });

  it('changes when a chart, an online entry, an index facet or the catalog list changes', async () => {
    const base = buildMergedCatalog(await inputs()).catalog.contentHash;
    const chartEdit = await withBrokenRnc((f) =>
      f.parsed
        ? {
            ...f,
            parsed: {
              ...f.parsed,
              charts: f.parsed.charts.map((c) => ({ ...c, zipfile_datetime_iso8601: '2027-01-01' }))
            }
          }
        : f
    );
    const variants: BuildInputs[] = [
      await inputs({ chartcatalogs: chartEdit }),
      await inputs({ online: { charts: [onlineEntry({ name: 'Renamed Radar' })] } }),
      await inputs({
        index: { ...INDEX, 'XX_RNC_Catalog.xml': { ...RNC_FACETS, bbox: [-11, -10, 10, 10] } }
      }),
      await inputs({ chartcatalogs: (await sampleFiles()).slice(0, 1) })
    ];
    for (const v of variants) {
      assert.notStrictEqual(buildMergedCatalog(v).catalog.contentHash, base);
    }
  });

  it('does not depend on the order files are read in', async () => {
    const a = buildMergedCatalog(await inputs()).catalog.contentHash;
    const b = buildMergedCatalog(await inputs({ chartcatalogs: (await sampleFiles()).reverse() }))
      .catalog.contentHash;
    assert.strictEqual(a, b);
  });

  it('does not depend on object key order', async () => {
    const a = buildMergedCatalog(await inputs()).catalog;
    const reverseKeys = (value: unknown): unknown => {
      if (Array.isArray(value)) {
        return value.map(reverseKeys);
      }
      if (value !== null && typeof value === 'object') {
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .reverse()
            .map(([k, v]) => [k, reverseKeys(v)])
        );
      }
      return value;
    };
    const reordered = reverseKeys(withoutHash(a)) as Omit<MergedCatalog, 'contentHash'>;
    assert.strictEqual(computeContentHash(reordered), a.contentHash);
  });
});

describe('readPublishedState', () => {
  it('counts loosely, so a catalog from an older schema still arms the drop guard', () => {
    const legacy = {
      schemaVersion: 0,
      contentHash: 'x',
      chartcatalogs: [{ charts: [1, 2, 3] }, { charts: [4] }, { unexpected: true }]
    };
    const state = readPublishedState(legacy, null);
    assert.strictEqual(state.catalogCount, 3);
    assert.strictEqual(state.chartCount, 4);
    assert.strictEqual(state.chartcatalogs.size, 0);
  });

  it('tolerates garbage', () => {
    const state = readPublishedState('not a catalog', null);
    assert.strictEqual(state.catalogCount, 0);
    assert.strictEqual(state.contentHash, null);
  });
});

describe('publishBlockers', () => {
  async function stateWith(count: number) {
    const { catalog } = buildMergedCatalog(await inputs({ chartcatalogs: await manyFiles(count) }));
    return readPublishedState(catalog, null);
  }

  async function catalogWith(count: number) {
    return buildMergedCatalog(await inputs({ chartcatalogs: await manyFiles(count) })).catalog;
  }

  it('allows a first publish', async () => {
    const { catalog } = buildMergedCatalog(await inputs());
    assert.deepStrictEqual(publishBlockers(catalog, null), []);
  });

  it('blocks an empty chartcatalogs or online list', async () => {
    const { catalog } = buildMergedCatalog(
      await inputs({ chartcatalogs: [], online: { charts: [] } })
    );
    const blockers = publishBlockers(catalog, null).join();
    assert.match(blockers, /no chartcatalogs catalogs/);
    assert.match(blockers, /online chart list is empty/);
  });

  it('allows a drop to exactly 80% of catalogs', async () => {
    assert.deepStrictEqual(publishBlockers(await catalogWith(8), await stateWith(10)), []);
  });

  it('blocks a drop below 80% of catalogs', async () => {
    assert.match(
      publishBlockers(await catalogWith(7), await stateWith(10)).join(),
      /catalogs dropped from 10 to 7/
    );
  });

  it('blocks a drop below 50% of charts', async () => {
    assert.match(
      publishBlockers(await catalogWith(4), await stateWith(10)).join(),
      /charts dropped from 10 to 4/
    );
  });
});

describe('decidePublish', () => {
  it('publishes when nothing is published yet', async () => {
    const { catalog } = buildMergedCatalog(await inputs());
    assert.deepStrictEqual(decidePublish(catalog, null, '{}', false), {
      publish: true,
      blockers: []
    });
  });

  it('skips an unchanged catalog and schema', async () => {
    const { catalog } = buildMergedCatalog(await inputs());
    const state = readPublishedState(catalog, '{}');
    assert.strictEqual(decidePublish(catalog, state, '{}', false).publish, false);
  });

  it('publishes a schema change even when the content is unchanged', async () => {
    const { catalog } = buildMergedCatalog(await inputs());
    const state = readPublishedState(catalog, '{"old":true}');
    assert.strictEqual(decidePublish(catalog, state, '{}', false).publish, true);
  });

  it('does not publish past blockers unless forced', async () => {
    const big = buildMergedCatalog(await inputs({ chartcatalogs: await manyFiles(10) })).catalog;
    const small = buildMergedCatalog(await inputs({ chartcatalogs: await manyFiles(2) })).catalog;
    const state = readPublishedState(big, '{}');
    assert.strictEqual(decidePublish(small, state, '{}', false).publish, false);
    assert.strictEqual(decidePublish(small, state, '{}', true).publish, true);
  });
});
