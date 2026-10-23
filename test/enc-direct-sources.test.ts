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
import {
  archiveJobs,
  assembleEncIndex,
  encIndexBlockers,
  encSources,
  jobKey,
  jobsToBuild,
  readPublishedEncIndex,
  unitsForArchive,
  unreadSources,
  type ArchiveJob,
  type ArchiveResult
} from '../dist/catalog/build-enc-index.js';
import type { EncIndex } from '../dist/catalog/enc-index-schema.js';
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
    assert.strictEqual(usaceDateTime('1/2/2026', '13:35:41'), '2026-01-02T13:35:41Z');
    assert.strictEqual(usaceDateTime('2026-01-02', ''), '');
  });

  it('lists each cell with an S-57 download, titled by its river and stretch', async () => {
    assert.deepStrictEqual((await parseUsaceIencCatalog(USACE_XML)).archives, [
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

  it('reads the buoy overlay catalog, which has the same layout', async () => {
    const buoys = `<?xml version='1.0' encoding='UTF-8'?>
<IENCBuoyProductCatalog>
  <Header><title>IENC Buoy Products Catalog</title></Header>
  <Cell>
    <name>3UABUOYS</name>
    <edition>95.0</edition>
    <s57_file>
      <location>https://ienccloud.us/ienc/products/files/buoys/3UABUOYS.zip</location>
      <date_posted>10/21/2026</date_posted>
      <time_posted>14:28</time_posted>
    </s57_file>
  </Cell>
</IENCBuoyProductCatalog>`;
    assert.deepStrictEqual((await parseUsaceIencCatalog(buoys)).archives, [
      {
        url: 'https://ienccloud.us/ienc/products/files/buoys/3UABUOYS.zip',
        version: '2026-10-21T14:28:00Z',
        title: '3UABUOYS'
      }
    ]);
  });

  it('versions an entry with an unreadable date by its raw text, and reads the rest', async () => {
    const odd = USACE_XML.replace('06/30/2026', '2026-06-30');
    const { archives, problems } = await parseUsaceIencCatalog(odd);
    assert.strictEqual(archives[0].version, 'raw:2026-06-30 9:40');
    assert.strictEqual(archives[1].version, '2026-01-02T00:00:00Z');
    assert.deepStrictEqual(problems, ['U37AG001: cannot read the posting date "2026-06-30 9:40"']);
  });

  it('does not take a time it cannot read for midnight', () => {
    assert.strictEqual(usaceDateTime('10/21/2026', '2:28 PM'), '');
    assert.strictEqual(usaceDateTime('10/21/2026', ''), '2026-10-21T00:00:00Z');
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
    const { archives } = await parseUsaceIencCatalog(USACE_XML);
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

// ---- A direct source beside chartcatalogs in the index build ----

const SQUARE = [
  [
    [-90, 30],
    [-89, 30],
    [-89, 31],
    [-90, 31],
    [-90, 30]
  ]
] as [number, number][][];

const SOURCES = encSources(
  {
    'ACE_BUOY_Catalog.xml': {
      label: 'US Inland Rivers Buoy Overlay (USACE)',
      category: 'navigation',
      format: 'enc',
      regions: ['us'],
      bbox: [-104, 28, -79, 49]
    }
  },
  [
    {
      id: 'USACE_IENC_BUOYS',
      label: 'US Inland Rivers Buoy Overlay (USACE)',
      format: 'usace-ienc-product-catalog',
      catalog: 'https://ienccloud.us/ienc/products/catalog/IENCBuoyProductsCatalog.xml'
    }
  ]
);

const OLD: ArchiveJob = {
  source: 'ACE_BUOY_Catalog',
  url: 'https://ienccloud.us/ienc/products/files/buoys/3UABUOYS.zip',
  version: '2016-09-29T00:00:00Z',
  title: 'Buoys Overlay S57 Format'
};

function direct(version: string): ArchiveJob {
  return { ...OLD, source: 'USACE_IENC_BUOYS', version, title: '3UABUOYS' };
}

function buoys(job: ArchiveJob, edition: number): ArchiveResult {
  return unitsForArchive(job, 'zip', [
    {
      path: 'ENC_ROOT/3UABUOYS.000',
      scale: null,
      edition,
      update: 0,
      coverage: [SQUARE]
    }
  ]);
}

function build(
  jobs: ArchiveJob[],
  built: [ArchiveJob, ArchiveResult][],
  previous: EncIndex | null,
  unread: string[] = []
) {
  return assembleEncIndex({
    sources: SOURCES,
    jobs,
    built: new Map(built.map(([job, result]) => [jobKey(job), result])),
    failed: new Map(),
    noaa: null,
    unreadSources: new Set(unread),
    previous: previous ? readPublishedEncIndex(JSON.parse(JSON.stringify(previous)), null) : null,
    now: new Date('2026-10-23T00:00:00Z')
  });
}

describe('a direct source publishing a cell chartcatalogs also lists', () => {
  // As published today: the overlay only from chartcatalogs, read when its
  // stale date was new.
  const before = build([OLD], [[OLD, buoys(OLD, 96)]], null).index;
  const fresh = direct('2026-10-21T14:28:00Z');
  const after = build([OLD, fresh], [[fresh, buoys(fresh, 95)]], before);

  it('takes the direct copy, even against a higher-looking stale version', () => {
    const units = after.index.units.filter((u) => u.id === '3UABUOYS');
    assert.strictEqual(units.length, 1);
    assert.strictEqual(units[0].source, 'USACE_IENC_BUOYS');
    assert.strictEqual(units[0].cells[0].version, '3UABUOYS_ED095_UP000');
  });

  it('records the chartcatalogs copy as shadowed, so the drop guard stays quiet', () => {
    assert.deepStrictEqual(
      after.index.archives.find((a) => a.source === 'ACE_BUOY_Catalog')?.shadowed,
      ['3UABUOYS']
    );
    assert.deepStrictEqual(encIndexBlockers(after.index, readPublishedEncIndex(before, null)), []);
  });

  it('reads the archive again when the producer reissues it, and moves the version', () => {
    const reissued = direct('2026-11-04T09:00:00Z');
    const state = readPublishedEncIndex(JSON.parse(JSON.stringify(after.index)), null);
    assert.deepStrictEqual(jobsToBuild([OLD, reissued], state), [reissued]);
    const next = build([OLD, reissued], [[reissued, buoys(reissued, 96)]], after.index);
    assert.strictEqual(
      next.index.units.find((u) => u.id === '3UABUOYS')?.cells[0].version,
      '3UABUOYS_ED096_UP000'
    );
  });

  it('keeps its published cells when its catalog cannot be read', () => {
    const result = build([OLD], [], after.index, ['USACE_IENC_BUOYS']);
    assert.deepStrictEqual(result.carriedForward, [
      'USACE_IENC_BUOYS: its catalog could not be read'
    ]);
    assert.strictEqual(
      result.index.units.find((u) => u.id === '3UABUOYS')?.source,
      'USACE_IENC_BUOYS'
    );
  });

  it('gives the cell back to chartcatalogs when the source is removed from the list', () => {
    const state = readPublishedEncIndex(JSON.parse(JSON.stringify(after.index)), null);
    assert.deepStrictEqual(jobsToBuild([OLD], state), [OLD]);
    const result = build([OLD], [[OLD, buoys(OLD, 96)]], after.index);
    assert.deepStrictEqual(result.removedUpstream, [jobKey(fresh)]);
    assert.strictEqual(
      result.index.units.find((u) => u.id === '3UABUOYS')?.source,
      'ACE_BUOY_Catalog'
    );
  });
});

describe('a direct catalog that lists nothing', () => {
  it('counts as unreadable, so the source keeps what is published', () => {
    const unread = unreadSources(SOURCES, [], new Map([['USACE_IENC_BUOYS', []]]));
    assert.ok(unread.has('USACE_IENC_BUOYS'));
  });
});

describe('unreadSources', () => {
  it('lists chartcatalogs files and direct catalogs that could not be read or list nothing', () => {
    const unread = unreadSources(
      SOURCES,
      [{ file: 'ACE_BUOY_Catalog.xml', parsed: null }],
      new Map([['USACE_IENC_BUOYS', []]])
    );
    assert.deepStrictEqual([...unread].sort(), ['ACE_BUOY_Catalog', 'USACE_IENC_BUOYS']);
    const read = unreadSources(
      SOURCES,
      [
        {
          file: 'ACE_BUOY_Catalog.xml',
          parsed: {
            header: { title: '', dateCreated: '', dateValid: '' },
            charts: [
              {
                number: '1',
                title: 'T',
                format: '',
                zipfile_location: OLD.url,
                zipfile_datetime_iso8601: OLD.version
              }
            ]
          }
        }
      ],
      new Map([['USACE_IENC_BUOYS', [{ url: OLD.url, version: 'v', title: 't' }]]])
    );
    assert.deepStrictEqual([...read], []);
  });
});
