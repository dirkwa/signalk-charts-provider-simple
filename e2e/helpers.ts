/**
 * Helpers shared by Playwright specs.  Wraps interactions with the
 * mock server's `__mock` control endpoints so tests stay readable.
 */

import type { Page } from '@playwright/test';

// Same default as playwright.config.ts. Used as a fallback when the
// page hasn't navigated yet (`page.url()` returns `about:blank`, whose
// origin is the literal string `"null"` — invalid for fetch).
const DEFAULT_MOCK_ORIGIN = 'http://127.0.0.1:4567';

function resolveMockOrigin(page: Page): string {
  const current = page.url();
  if (current && current !== 'about:blank') {
    return new URL(current).origin;
  }
  return DEFAULT_MOCK_ORIGIN;
}

/**
 * Reset the mock server to its initial state, then merge `state` into
 * it.  Use at the start of every test that depends on a specific
 * backend shape — the mock state is process-wide and persists between
 * specs otherwise.
 */
export async function setMockState(page: Page, state: Record<string, unknown>): Promise<void> {
  // Always reset first so prior tests don't leak.
  const origin = resolveMockOrigin(page);
  const resetRes = await page.request.post(`${origin}/__mock/reset`);
  if (!resetRes.ok()) {
    throw new Error(`mock reset failed: ${resetRes.status()} ${resetRes.statusText()}`);
  }
  const putRes = await page.request.put(`${origin}/__mock/state`, { data: state });
  if (!putRes.ok()) {
    throw new Error(`mock state PUT failed: ${putRes.status()} ${putRes.statusText()}`);
  }
}

/**
 * Patch mock state without resetting first.  Use to drive state
 * transitions mid-test (e.g. flip a chart from converting to installed
 * to verify the UI re-renders).
 */
export async function patchMockState(page: Page, state: Record<string, unknown>): Promise<void> {
  const origin = resolveMockOrigin(page);
  const res = await page.request.put(`${origin}/__mock/state`, { data: state });
  if (!res.ok()) {
    throw new Error(`mock state PUT failed: ${res.status()} ${res.statusText()}`);
  }
}
