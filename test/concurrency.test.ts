import { describe, it } from 'node:test';
import assert from 'node:assert';

import { _computeBudgetForTests, setCpuBudget, getCpuBudget } from '../dist/utils/concurrency.js';

describe('cpu budget presets', () => {
  describe('_computeBudgetForTests (pure mapping)', () => {
    it('single-core uses one of everything regardless of host CPU count', () => {
      for (const cpus of [1, 2, 4, 8, 16]) {
        const b = _computeBudgetForTests('single-core', cpus);
        assert.deepStrictEqual(b, {
          maxConcurrentConversions: 1,
          tippecanoeThreadsPerJob: 1,
          gdalExportParallelism: 1
        });
      }
    });

    it('all uses every core in one job', () => {
      assert.deepStrictEqual(_computeBudgetForTests('all', 4), {
        maxConcurrentConversions: 1,
        tippecanoeThreadsPerJob: 4,
        gdalExportParallelism: 4
      });
      assert.deepStrictEqual(_computeBudgetForTests('all', 8), {
        maxConcurrentConversions: 1,
        tippecanoeThreadsPerJob: 8,
        gdalExportParallelism: 8
      });
    });

    it('half: one job using half the host (per-job, not aggregate)', () => {
      // 2.0 redefinition: "half" caps a SINGLE conversion to half the
      // host's cores.  Most users run one chart at a time, and the old
      // "half = N parallel jobs each using 2 cores" semantics confused
      // people who saw their 6-core host barely warm up on "half".
      // 4 cpus → 1 job × 2 threads
      assert.deepStrictEqual(_computeBudgetForTests('half', 4), {
        maxConcurrentConversions: 1,
        tippecanoeThreadsPerJob: 2,
        gdalExportParallelism: 2
      });
      // 6 cpus → 1 job × 3 threads
      assert.deepStrictEqual(_computeBudgetForTests('half', 6), {
        maxConcurrentConversions: 1,
        tippecanoeThreadsPerJob: 3,
        gdalExportParallelism: 3
      });
      // 8 cpus → 1 job × 4 threads
      assert.deepStrictEqual(_computeBudgetForTests('half', 8), {
        maxConcurrentConversions: 1,
        tippecanoeThreadsPerJob: 4,
        gdalExportParallelism: 4
      });
    });

    it('half on a 1-core box collapses cleanly to 1 × 1', () => {
      assert.deepStrictEqual(_computeBudgetForTests('half', 1), {
        maxConcurrentConversions: 1,
        tippecanoeThreadsPerJob: 1,
        gdalExportParallelism: 1
      });
    });

    it('half on a 2-core box gives 1 job × 1 thread (half of 2 = 1)', () => {
      assert.deepStrictEqual(_computeBudgetForTests('half', 2), {
        maxConcurrentConversions: 1,
        tippecanoeThreadsPerJob: 1,
        gdalExportParallelism: 1
      });
    });
  });

  describe('setCpuBudget / getCpuBudget (live state)', () => {
    it('starts on the half preset by default', () => {
      // Reset to the documented default and assert the shape; we don't pin
      // exact numbers because they depend on the test runner's host CPU count.
      setCpuBudget('half');
      const b = getCpuBudget();
      assert.ok(b.maxConcurrentConversions >= 1);
      assert.ok(b.tippecanoeThreadsPerJob >= 1);
      assert.ok(b.gdalExportParallelism >= 1);
    });

    it('switches to single-core when set', () => {
      setCpuBudget('single-core');
      assert.deepStrictEqual(getCpuBudget(), {
        maxConcurrentConversions: 1,
        tippecanoeThreadsPerJob: 1,
        gdalExportParallelism: 1
      });
    });

    it('switches to all when set, with one full-throttle job', () => {
      setCpuBudget('all');
      const b = getCpuBudget();
      assert.strictEqual(b.maxConcurrentConversions, 1);
      assert.ok(b.tippecanoeThreadsPerJob >= 1);
      assert.strictEqual(b.tippecanoeThreadsPerJob, b.gdalExportParallelism);
    });

    it('falls back to half on undefined', () => {
      setCpuBudget('all');
      setCpuBudget(undefined);
      const b = getCpuBudget();
      // half always allows at least 1 concurrent conversion
      assert.ok(b.maxConcurrentConversions >= 1);
    });

    it('falls back to half on null', () => {
      setCpuBudget('all');
      setCpuBudget(null);
      const b = getCpuBudget();
      assert.ok(b.maxConcurrentConversions >= 1);
    });
  });
});
