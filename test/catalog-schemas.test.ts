import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  CatalogDataSchema,
  CatalogInstallsMapSchema,
  CatalogRegistryCacheSchema,
  GithubContentsListingSchema,
  safeParse
} from '../dist/utils/catalog-schemas.js';

describe('catalog schemas (cache JSON validation)', () => {
  describe('CatalogDataSchema', () => {
    const valid = {
      fetchedAt: '2026-05-08T00:00:00Z',
      catalogFile: 'NL_IENC.xml',
      header: { title: 'NL IENC', dateCreated: '2026-05-01', dateValid: '2027-05-01' },
      charts: [
        {
          number: '1',
          title: 'Waddenzee',
          format: 'S-57',
          zipfile_location: 'https://example.com/wadd.zip',
          zipfile_datetime_iso8601: '2026-05-01T00:00:00Z'
        }
      ]
    };

    it('accepts a well-formed catalog', () => {
      assert.deepStrictEqual(safeParse(CatalogDataSchema, valid), valid);
    });

    it('accepts an empty charts array (catalog with no entries yet)', () => {
      const empty = { ...valid, charts: [] };
      assert.deepStrictEqual(safeParse(CatalogDataSchema, empty), empty);
    });

    it('rejects a missing top-level field', () => {
      const { header: _h, ...without } = valid;
      assert.strictEqual(safeParse(CatalogDataSchema, without), null);
    });

    it('rejects a chart with a non-string zipfile_location', () => {
      const bad = { ...valid, charts: [{ ...valid.charts[0], zipfile_location: 42 }] };
      assert.strictEqual(safeParse(CatalogDataSchema, bad), null);
    });

    it('rejects a non-array charts field', () => {
      const bad = { ...valid, charts: 'not-an-array' };
      assert.strictEqual(safeParse(CatalogDataSchema, bad), null);
    });
  });

  describe('CatalogInstallsMapSchema', () => {
    it('accepts an empty map', () => {
      assert.deepStrictEqual(safeParse(CatalogInstallsMapSchema, {}), {});
    });

    it('accepts a map keyed by chart number', () => {
      const m = {
        '1': {
          catalogFile: 'NL_IENC.xml',
          zipfile_datetime_iso8601: '2026-05-01T00:00:00Z',
          installedAt: '2026-05-08T00:00:00Z',
          zipfile_location: 'https://example.com/wadd.zip'
        }
      };
      assert.deepStrictEqual(safeParse(CatalogInstallsMapSchema, m), m);
    });

    it('rejects a value missing zipfile_location', () => {
      const m = {
        '1': {
          catalogFile: 'NL_IENC.xml',
          zipfile_datetime_iso8601: '2026-05-01T00:00:00Z',
          installedAt: '2026-05-08T00:00:00Z'
        }
      };
      assert.strictEqual(safeParse(CatalogInstallsMapSchema, m), null);
    });
  });

  describe('CatalogRegistryCacheSchema', () => {
    it('accepts a list of registry entries', () => {
      const list = [{ file: 'NL_IENC.xml', label: 'NL IENC', category: 'ienc' }];
      assert.deepStrictEqual(safeParse(CatalogRegistryCacheSchema, list), list);
    });

    it('rejects an entry with an unknown category', () => {
      const list = [{ file: 'X.xml', label: 'X', category: 'star-trek' }];
      assert.strictEqual(safeParse(CatalogRegistryCacheSchema, list), null);
    });
  });

  describe('GithubContentsListingSchema', () => {
    it('accepts a real-shaped GitHub contents response (extra fields ignored)', () => {
      const list = [
        { name: 'NL_IENC_Catalog.xml', size: 1234, sha: 'abc' },
        { name: 'README.md', size: 50 }
      ];
      assert.deepStrictEqual(safeParse(GithubContentsListingSchema, list), list);
    });

    it('rejects when name is missing', () => {
      assert.strictEqual(safeParse(GithubContentsListingSchema, [{ size: 1 }]), null);
    });
  });

  describe('safeParse', () => {
    it('returns null on null input', () => {
      assert.strictEqual(safeParse(CatalogInstallsMapSchema, null), null);
    });
  });
});
