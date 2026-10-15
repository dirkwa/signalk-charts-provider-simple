/**
 * Serves the merged chart catalog built from this working copy, so a
 * contributor can see an edit to `catalog/online-charts.json` (or the
 * chartcatalogs index) in the Chart Catalog tab before opening a PR.
 *
 * The catalog is rebuilt by the publish CLI on every request, exactly as
 * the workflow builds it, so an edit shows up on "Refresh catalog index"
 * without restarting anything. Left out of the npm package.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLISH_CLI = path.join(REPO_ROOT, 'dist', 'catalog', 'publish-catalog-cli.js');
const PUBLISHED_URL = 'https://dirkwa.github.io/signalk-charts-provider-simple/catalog.json';
const CHARTCATALOGS_REPO = 'https://github.com/chartcatalogs/catalogs.git';

const SITE_FILES: Record<string, string> = {
  '/catalog.json': 'application/json',
  '/catalog.schema.json': 'application/json',
  '/index.html': 'text/html; charset=utf-8'
};

function git(args: string[]): boolean {
  return spawnSync('git', args, { stdio: 'inherit' }).status === 0;
}

/** A local chartcatalogs checkout, cloned once and updated when possible. */
function chartcatalogsCheckout(dir: string): void {
  if (!fs.existsSync(path.join(dir, '.git'))) {
    if (!git(['clone', '--depth', '1', CHARTCATALOGS_REPO, dir])) {
      throw new Error(`Could not clone ${CHARTCATALOGS_REPO}`);
    }
  } else if (!git(['-C', dir, 'pull', '--ff-only', '--quiet'])) {
    console.warn('Could not update chartcatalogs; using the copy already downloaded.');
  }
}

/** Build the site into `out`; returns the publish CLI's output when it fails. */
function build(chartcatalogs: string, out: string): string | null {
  const result = spawnSync(
    process.execPath,
    [
      PUBLISH_CLI,
      '--chartcatalogs',
      chartcatalogs,
      '--index',
      path.join(REPO_ROOT, 'catalog', 'chartcatalogs-index.json'),
      '--online',
      path.join(REPO_ROOT, 'catalog', 'online-charts.json'),
      '--out',
      out,
      '--repo',
      'dirkwa/signalk-charts-provider-simple',
      '--published-url',
      PUBLISHED_URL
    ],
    { encoding: 'utf8' }
  );
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  return result.status === 0 ? null : `${result.stdout}${result.stderr}`;
}

function main(): void {
  const { values } = parseArgs({ options: { port: { type: 'string', default: '8123' } } });
  const port = Number(values.port);
  const work = path.join(os.tmpdir(), 'signalk-catalog-preview');
  const chartcatalogs = path.join(work, 'chartcatalogs');
  const out = path.join(work, 'site');

  chartcatalogsCheckout(chartcatalogs);
  if (build(chartcatalogs, out) !== null) {
    process.exit(1);
  }

  http
    .createServer((req, res) => {
      const route = new URL(req.url ?? '/', 'http://localhost').pathname;
      const file = route === '/' ? '/index.html' : route;
      const type = Object.hasOwn(SITE_FILES, file) ? SITE_FILES[file] : undefined;
      if (!type) {
        res.writeHead(404).end();
        return;
      }
      if (file === '/catalog.json') {
        const failure = build(chartcatalogs, out);
        if (failure !== null) {
          res.writeHead(500, { 'Content-Type': 'text/plain' }).end(failure);
          return;
        }
      }
      res.writeHead(200, { 'Content-Type': type }).end(fs.readFileSync(path.join(out, file)));
    })
    .listen(port, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${String(port)}/catalog.json`;
      console.log(`
Serving the catalog from this working copy at ${url}

Start a Signal K server with CHARTS_CATALOG_URL=${url} set in its
environment, open the Chart Catalog tab and press "Refresh catalog index".
Each refresh rebuilds the catalog, so edits show up without a restart.
Press Ctrl+C to stop.`);
    });
}

try {
  main();
} catch (err: unknown) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
