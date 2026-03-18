const os = require('node:os');
const path = require('node:path');
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.js',
  timeout: 30_000,
  outputDir: path.join(os.tmpdir(), 'signet-playwright-results'),
  expect: {
    timeout: 5_000,
  },
  retries: process.env.CI ? 2 : 0,
  use: {
    browserName: 'chromium',
    headless: true,
    trace: 'on-first-retry',
  },
  reporter: [['list']],
});
