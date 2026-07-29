import { defineConfig } from '@playwright/test';

/**
 * LlamaVideoBlock test configuration.
 *
 * Every test drives a real Chrome with the unpacked extension loaded, so the suite runs
 * serially against one fixture server. Chrome's own autoplay policy is disabled inside the
 * browser launch args (see tests/helpers.js) — without that we would be measuring Chrome's
 * blocking rather than LlamaVideoBlock's.
 */
export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.js',

  // Extension tests each own a browser with its own profile directory; running them in
  // parallel buys little and makes failures much harder to read.
  fullyParallel: false,
  workers: 1,

  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',

  timeout: 30_000,
  expect: { timeout: 7_000 },

  webServer: {
    command: 'node tests/fixtures/server.mjs',
    url: 'http://127.0.0.1:8787/health',
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
