/**
 * Parser for chartcatalogs.github.io catalog XML (the NOAA RNC product
 * catalog subset used by OpenCPN). Shared by the plugin's catalog manager
 * and the merged-catalog build so both read the files identically.
 */

import { parseStringPromise } from 'xml2js';
import type { CatalogChart, CatalogHeader } from '../utils/catalog-schemas.js';

export interface ParsedChartcatalogsXml {
  header: CatalogHeader;
  charts: CatalogChart[];
}

// xml2js keeps element text verbatim, and some catalogs wrap values on
// their own lines (ACE_BUOY's zip URL is surrounded by newlines), which
// would otherwise reach the downloader as an invalid URL.
function text(node: Record<string, string[] | undefined>, ...names: string[]): string {
  for (const name of names) {
    const value = node[name]?.[0];
    if (typeof value === 'string') {
      return value.trim();
    }
  }
  return '';
}

/**
 * Parse one catalog file. Entries without a chart number or download
 * location are dropped: they cannot be installed or tracked for updates.
 * Throws when the document is not a chartcatalogs catalog at all.
 */
export async function parseChartcatalogsXml(xmlData: string): Promise<ParsedChartcatalogsXml> {
  const result: unknown = await parseStringPromise(xmlData);

  if (typeof result !== 'object' || result === null) {
    throw new Error('Invalid XML parse result');
  }

  const parsed = result as Record<string, unknown>;
  const root = (parsed.RncProductCatalogChartCatalogs ?? parsed.EncProductCatalogcellCatalogs) as
    Record<string, unknown> | undefined;

  if (!root) {
    throw new Error('Unexpected XML root element');
  }

  const headerArr = root.Header as Record<string, string[] | undefined>[] | undefined;
  const headerNode = headerArr?.[0] ?? {};
  const header: CatalogHeader = {
    title: text(headerNode, 'title'),
    dateCreated: text(headerNode, 'date_created'),
    dateValid: text(headerNode, 'date_valid')
  };

  const chartNodes = (root.chart ?? root.cell ?? []) as Record<string, string[] | undefined>[];
  const charts: CatalogChart[] = chartNodes
    .map((node): CatalogChart => ({
      number: text(node, 'number', 'name'),
      title: text(node, 'title', 'lname'),
      format: text(node, 'format'),
      zipfile_location: text(node, 'zipfile_location'),
      zipfile_datetime_iso8601: text(node, 'zipfile_datetime_iso8601')
    }))
    .filter((c) => c.number !== '' && c.zipfile_location !== '');

  return { header, charts };
}
