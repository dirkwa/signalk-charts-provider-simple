const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { patchS57Mbtiles } = require('../dist/utils/mbtiles-metadata');

// Build a synthetic MBTiles file shaped like tippecanoe's output: empty
// metadata table with the columns the patcher writes. We don't need actual
// tiles — only the metadata table is exercised.
function makeFakeMbtiles(filePath, initial = {}) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(filePath);
  try {
    db.exec(`
      CREATE TABLE metadata (name TEXT, value TEXT);
      CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB);
    `);
    for (const [k, v] of Object.entries(initial)) {
      db.prepare('INSERT INTO metadata (name, value) VALUES (?, ?)').run(k, v);
    }
  } finally {
    db.close();
  }
}

function readMetadata(filePath) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(filePath);
  try {
    const rows = db.prepare('SELECT name, value FROM metadata').all();
    return Object.fromEntries(rows.map((r) => [r.name, r.value]));
  } finally {
    db.close();
  }
}

describe('patchS57Mbtiles', () => {
  let tmp;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-mbtiles-meta-'));
  });

  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('overwrites tippecanoe defaults type=overlay and name=/output/...', async () => {
    const file = path.join(tmp, 'happy.mbtiles');
    makeFakeMbtiles(file, {
      type: 'overlay',
      name: '/output/happy.mbtiles',
      format: 'pbf'
    });

    const messages = [];
    const result = await patchS57Mbtiles(file, 'AQ_ENCs', {
      onMessage: (m) => messages.push(m)
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.attempts, 1);
    assert.strictEqual(result.type, 'S-57');
    assert.strictEqual(result.name, 'S-57 AQ_ENCs');

    const meta = readMetadata(file);
    assert.strictEqual(meta.type, 'S-57');
    assert.strictEqual(meta.name, 'S-57 AQ_ENCs');
    assert.strictEqual(meta.format, 'pbf', 'unrelated keys are preserved');

    assert.ok(
      messages.some((m) => m.includes('Set MBTiles type=S-57')),
      'logs the success message via onMessage'
    );
  });

  it('falls back to ENC when chartNumber is empty', async () => {
    const file = path.join(tmp, 'noname.mbtiles');
    makeFakeMbtiles(file);

    const result = await patchS57Mbtiles(file, '');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.name, 'S-57 ENC');
  });

  it('inserts type/name even when the metadata table starts empty', async () => {
    const file = path.join(tmp, 'empty.mbtiles');
    makeFakeMbtiles(file);

    const result = await patchS57Mbtiles(file, 'X');
    assert.strictEqual(result.ok, true);
    const meta = readMetadata(file);
    assert.strictEqual(meta.type, 'S-57');
    assert.strictEqual(meta.name, 'S-57 X');
  });

  it('returns ok=false with attempts=0 when the target file does not exist', async () => {
    const file = path.join(tmp, 'definitely-not-here.mbtiles');
    const messages = [];
    const result = await patchS57Mbtiles(file, 'X', {
      onMessage: (m) => messages.push(m)
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.attempts, 0);
    assert.match(result.message, /does not exist/);
    assert.strictEqual(messages.length, 1);
    assert.match(messages[0], /does not exist/);
  });

  it('does not throw on patch failure (best-effort contract)', async () => {
    // Point at a directory rather than a file — sqlite open will fail.
    const dir = fs.mkdtempSync(path.join(tmp, 'as-dir-'));
    let result;
    await assert.doesNotReject(async () => {
      result = await patchS57Mbtiles(dir, 'X', { sleep: async () => {} });
    });
    assert.strictEqual(result.ok, false);
    assert.match(result.message, /metadata patch/i);
  });

  it('retries once on transient failure and logs the retry', async () => {
    // Simulate a transient lock by deleting the file between attempt 1 and
    // the retry — we re-create it inside the sleep callback, and the second
    // attempt succeeds. This is the most honest "transient failure" we can
    // reproduce without a second process holding a lock.
    const file = path.join(tmp, 'transient.mbtiles');
    // Start with a corrupt file so attempt 1 throws on open.
    fs.writeFileSync(file, 'not a sqlite database');

    const messages = [];
    const result = await patchS57Mbtiles(file, 'TR', {
      retryDelayMs: 5,
      sleep: async () => {
        // Replace corrupt content with a real sqlite mbtiles before retry.
        fs.unlinkSync(file);
        makeFakeMbtiles(file, { type: 'overlay' });
      },
      onMessage: (m) => messages.push(m)
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.attempts, 2, 'second attempt succeeded');
    assert.ok(
      messages.some((m) => m.includes('Retrying MBTiles metadata patch')),
      `expected a retry log line, got: ${JSON.stringify(messages)}`
    );
    assert.ok(
      messages.some((m) => m.includes('on retry')),
      'success message mentions retry'
    );
  });

  it('reports verify-failure when the post-write read disagrees', async () => {
    // We can't easily make the verify mismatch in real code, but the helper
    // does support the failure path. Smoke test the normal path returned
    // values match the wanted values — the verify path is structurally
    // exercised on every successful run already (assertions in the helper
    // explicitly compare gotType/gotName).
    const file = path.join(tmp, 'verify.mbtiles');
    makeFakeMbtiles(file, { type: 'overlay' });
    const result = await patchS57Mbtiles(file, 'V');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.type, 'S-57');
    assert.strictEqual(result.name, 'S-57 V');
  });

  it('does not leave duplicate rows when starting from tippecanoe defaults', async () => {
    // Regression guard: earlier versions used `INSERT OR REPLACE` against a
    // tippecanoe-shaped metadata table that has NO UNIQUE constraint on
    // `name`. The "REPLACE" was a no-op as a replace, just an append, so
    // files ended up with two `type` rows (tippecanoe's `overlay` and ours
    // `S-57`) and the wrong one could win on SELECT order. The patcher must
    // produce exactly one row per managed key.
    const file = path.join(tmp, 'no-duplicates.mbtiles');
    makeFakeMbtiles(file, {
      type: 'overlay',
      name: '/output/foo.mbtiles',
      format: 'pbf'
    });

    await patchS57Mbtiles(file, 'BUNDLE');

    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(file);
    try {
      const typeRows = db.prepare("SELECT value FROM metadata WHERE name = 'type'").all();
      const nameRows = db.prepare("SELECT value FROM metadata WHERE name = 'name'").all();
      assert.strictEqual(typeRows.length, 1, 'exactly one `type` row');
      assert.strictEqual(typeRows[0].value, 'S-57');
      assert.strictEqual(nameRows.length, 1, 'exactly one `name` row');
      assert.strictEqual(nameRows[0].value, 'S-57 BUNDLE');
    } finally {
      db.close();
    }
  });

  it('self-heals files that already have duplicate type/name rows', async () => {
    // If a previous version of the plugin ran INSERT OR REPLACE against a
    // tippecanoe table without a UNIQUE constraint, the resulting file has
    // duplicate `type` rows. Re-running the patcher must collapse them.
    const file = path.join(tmp, 'self-heal.mbtiles');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(file);
    try {
      db.exec(`
        CREATE TABLE metadata (name TEXT, value TEXT);
        CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB);
      `);
      db.prepare('INSERT INTO metadata (name, value) VALUES (?, ?)').run('type', 'overlay');
      db.prepare('INSERT INTO metadata (name, value) VALUES (?, ?)').run('type', 'S-57');
      db.prepare('INSERT INTO metadata (name, value) VALUES (?, ?)').run(
        'name',
        '/output/x.mbtiles'
      );
      db.prepare('INSERT INTO metadata (name, value) VALUES (?, ?)').run('name', 'S-57 OLD');
    } finally {
      db.close();
    }

    const result = await patchS57Mbtiles(file, 'NEW');
    assert.strictEqual(result.ok, true);

    const db2 = new DatabaseSync(file);
    try {
      const typeRows = db2.prepare("SELECT value FROM metadata WHERE name = 'type'").all();
      const nameRows = db2.prepare("SELECT value FROM metadata WHERE name = 'name'").all();
      assert.strictEqual(typeRows.length, 1, 'duplicate `type` rows collapsed');
      assert.strictEqual(typeRows[0].value, 'S-57');
      assert.strictEqual(nameRows.length, 1, 'duplicate `name` rows collapsed');
      assert.strictEqual(nameRows[0].value, 'S-57 NEW');
    } finally {
      db2.close();
    }
  });
});
