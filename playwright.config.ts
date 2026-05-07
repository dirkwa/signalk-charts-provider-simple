import { defineConfig, devices } from '@playwright/test';

const PORT = 4567;
const BASE_URL = `http://127.0.0.1:${PORT}/plugins/signalk-charts-provider-simple/`;

export default defineConfig({
  testDir: './e2e',
  // Skip the mock-server source file itself.
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false, // Mock state is shared; serial keeps tests isolated.
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  // CI: line-friendly text reporter.  Local: HTML report so a developer
  // can drill into a failure by opening playwright-report/index.html.
  reporter: process.env.CI ? 'list' : 'html',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    headless: true
    // Each test resets the mock state via POST /__mock/reset, so a stale
    // state from a previous test can't leak.  Tests then PUT their own
    // state shape and navigate.
  },
  webServer: {
    // Mock server compiled to dist-e2e/e2e/mock-server.js.  Playwright
    // runs the .ts specs directly via its own loader; only the mock
    // server needs a JS build because it runs as a separate child
    // Node process.
    command: `node dist-e2e/e2e/mock-server.js`,
    env: { PORT: String(PORT) },
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    }
  ]
});
