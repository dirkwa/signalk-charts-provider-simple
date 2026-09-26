/**
 * Builds the merged chart catalog into a static site directory for GitHub
 * Pages. Run by `.github/workflows/publish-catalog.yml`; not used by the
 * plugin at runtime, and left out of the npm package.
 *
 * Writes `changed=true|false` to `$GITHUB_OUTPUT`: the workflow only deploys
 * when the content (or the published JSON Schema) differs from what is
 * already on Pages.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { Static, TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { parseChartcatalogsXml } from './chartcatalogs-xml.js';
import {
  buildMergedCatalog,
  decidePublish,
  readPublishedState,
  type ChartcatalogsFile,
  type PublishedState
} from './build-merged-catalog.js';
import {
  ChartcatalogsIndexSchema,
  OnlineChartsSourceFileSchema,
  publishedJsonSchema,
  schemaErrors,
  type MergedCatalog
} from './merged-catalog-schema.js';

function readJson<T extends TSchema>(file: string, schema: T): Static<T> {
  const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Value.Check(schema, value)) {
    throw new Error(`${file} is invalid:\n  ${schemaErrors(schema, value).join('\n  ')}`);
  }
  return value;
}

async function readChartcatalogs(dir: string): Promise<ChartcatalogsFile[]> {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('_Catalog.xml'));
  const result: ChartcatalogsFile[] = [];
  for (const file of files) {
    try {
      const parsed = await parseChartcatalogsXml(fs.readFileSync(path.join(dir, file), 'utf8'));
      result.push({ file, parsed });
    } catch (err) {
      console.log(
        `::warning::Could not parse ${file}: ${err instanceof Error ? err.message : String(err)}`
      );
      result.push({ file, parsed: null });
    }
  }
  return result;
}

/** A published site file's text, or null when it does not exist yet. */
async function fetchText(url: string): Promise<string | null> {
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`HTTP ${String(response.status)} fetching ${url}`);
  }
  return response.text();
}

async function fetchPublishedState(catalogUrl: string): Promise<PublishedState | null> {
  const catalogText = await fetchText(catalogUrl);
  if (catalogText === null) {
    return null;
  }
  const schemaText = await fetchText(new URL('catalog.schema.json', catalogUrl).href);
  return readPublishedState(JSON.parse(catalogText), schemaText);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${String(c.charCodeAt(0))};`);
}

function landingPage(catalog: MergedCatalog): string {
  const { chartcatalogs, online } = catalog.sources;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Signal K chart catalog</title></head>
<body>
<h1>Signal K chart catalog</h1>
<p>A merged catalog of downloadable and online charts, used by the Chart Catalog tab of
<a href="${escapeHtml(online.homepage)}">signalk-charts-provider-simple</a>.</p>
<ul>
<li><a href="catalog.json">catalog.json</a></li>
<li><a href="catalog.schema.json">catalog.schema.json</a></li>
</ul>
<p>Downloadable charts come from <a href="${escapeHtml(chartcatalogs.homepage)}">chartcatalogs.github.io</a>
(${escapeHtml(chartcatalogs.license)}). Report problems with them to the
<a href="${escapeHtml(chartcatalogs.issues)}">chartcatalogs issue tracker</a>; report problems with
online charts <a href="${escapeHtml(online.issues)}">here</a>.</p>
</body></html>
`;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      chartcatalogs: { type: 'string' },
      index: { type: 'string' },
      online: { type: 'string' },
      out: { type: 'string' },
      repo: { type: 'string' },
      'published-url': { type: 'string' },
      commit: { type: 'string' },
      force: { type: 'boolean', default: false }
    }
  });
  const { chartcatalogs: ccDir, index: indexFile, online: onlineFile, out, repo } = values;
  const publishedUrl = values['published-url'];
  if (!ccDir || !indexFile || !onlineFile || !out || !repo || !publishedUrl) {
    throw new Error(
      '--chartcatalogs, --index, --online, --out, --repo and --published-url are required'
    );
  }

  const published = await fetchPublishedState(publishedUrl);
  const { catalog, unindexed, staleIndexEntries, carriedForward, skipped, droppedCharts } =
    buildMergedCatalog({
      chartcatalogs: await readChartcatalogs(ccDir),
      chartcatalogsCommit: values.commit,
      index: readJson(indexFile, ChartcatalogsIndexSchema),
      online: readJson(onlineFile, OnlineChartsSourceFileSchema),
      repo,
      previous: published?.chartcatalogs,
      now: new Date()
    });

  for (const file of carriedForward) {
    console.log(`::warning::${file} is broken or empty upstream; kept the published entry`);
  }
  for (const file of skipped) {
    console.log(`::warning::${file} is broken upstream and was never published; left out`);
  }
  for (const chart of droppedCharts) {
    console.log(`::warning::Dropped ${chart}: download location is not an http(s) URL`);
  }
  for (const file of unindexed) {
    console.log(
      `::warning::${file} is not in the chartcatalogs index; published without location or type facets`
    );
  }
  for (const file of staleIndexEntries) {
    console.log(`::notice::${file} is in the index but no longer in chartcatalogs`);
  }

  const schemaText = JSON.stringify(
    publishedJsonSchema(new URL('catalog.schema.json', publishedUrl).href),
    null,
    2
  );
  const { publish, blockers } = decidePublish(catalog, published, schemaText, values.force);
  if (blockers.length > 0) {
    const message = `Refusing to publish:\n  ${blockers.join('\n  ')}`;
    if (!values.force) {
      throw new Error(message);
    }
    console.log(`::warning::Forced past: ${message}`);
  }

  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'catalog.json'), JSON.stringify(catalog));
  fs.writeFileSync(path.join(out, 'catalog.schema.json'), schemaText);
  fs.writeFileSync(path.join(out, 'index.html'), landingPage(catalog));

  const charts = catalog.chartcatalogs.reduce((n, c) => n + c.charts.length, 0);
  console.log(
    `Catalog ${catalog.contentHash.slice(0, 12)}: ${String(catalog.chartcatalogs.length)} chartcatalogs catalogs (${String(charts)} charts), ${String(catalog.online.length)} online charts; ${publish ? 'publishing' : 'unchanged, not publishing'}`
  );
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${String(publish)}\n`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
