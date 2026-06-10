import { describe, it } from 'node:test';
import assert from 'node:assert';

import { throwJobFailure, type FailedJobResult } from '../dist/utils/job-failure.js';

// Collect the lines the helper would surface, and capture whether it threw and
// with what message. throwJobFailure always throws, so every case asserts that.
function run(result: FailedJobResult): {
  lines: string[];
  message: string;
} {
  const lines: string[] = [];
  try {
    throwJobFailure(result, 'gdal-export', (t) => lines.push(t));
  } catch (err) {
    return { lines, message: err instanceof Error ? err.message : String(err) };
  }
  assert.fail('throwJobFailure did not throw');
}

describe('throwJobFailure', () => {
  it('surfaces a tail of the container log and throws the labelled exit message', () => {
    const log = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`);
    const { lines, message } = run({ exitCode: 1, log });

    assert.strictEqual(message, 'gdal-export failed with exit code 1');
    // Headline names the count, then the last 10 lines verbatim.
    assert.match(lines[0], /exit 1\. Last 10 of 25 container log line\(s\):/);
    assert.deepStrictEqual(
      lines.slice(1),
      log.slice(-10).map((l) => `  ${l}`)
    );
  });

  it('surfaces the runtime error line followed by the log tail when both are set', () => {
    const { lines, message } = run({
      exitCode: 1,
      log: ['some output'],
      error: 'Container exited with code 137'
    });

    assert.strictEqual(message, 'gdal-export failed with exit code 1');
    assert.deepStrictEqual(lines, [
      'gdal-export: container runtime reported: Container exited with code 137',
      'gdal-export: exit 1. Last 1 of 1 container log line(s):',
      '  some output'
    ]);
  });

  it('reports a no-output container with its status', () => {
    const { lines, message } = run({ exitCode: 1, log: [], status: 'failed' });

    assert.strictEqual(message, 'gdal-export failed with exit code 1');
    assert.match(lines[0], /container produced no output \(exit 1, status failed\)/);
  });

  it('reports a no-output container without a status when none is given', () => {
    const { lines } = run({ exitCode: 1, log: [] });

    assert.match(lines[0], /container produced no output \(exit 1\)\./);
    assert.doesNotMatch(lines[0], /status/);
  });
});
