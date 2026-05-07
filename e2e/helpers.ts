/**
 * Helpers shared by Playwright specs.  Wraps interactions with the
 * mock server's `__mock` control endpoints so tests stay readable.
 */

import type { Page } from '@playwright/test';

/**
 * Reset the mock server to its initial state, then merge `state` into
 * it.  Use at the start of every test that depends on a specific
 * backend shape — the mock state is process-wide and persists between
 * specs otherwise.
 */
export async function setMockState(page: Page, state: Record<string, unknown>): Promise<void> {
  // Always reset first so prior tests don't leak.
  const baseURL = page.context().browser()?.contexts()[0]?.pages()[0]?.url() ?? '';
  // Derive the harness origin from the page; baseURL on the context
  // isn't always set up early enough.
  const origin = new URL(page.url() || baseURL || 'http://127.0.0.1:4567').origin;
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
  const origin = new URL(page.url()).origin;
  const res = await page.request.put(`${origin}/__mock/state`, { data: state });
  if (!res.ok()) {
    throw new Error(`mock state PUT failed: ${res.status()} ${res.statusText()}`);
  }
}
