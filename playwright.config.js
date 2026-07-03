const { defineConfig, devices } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config({ quiet: true });

const storageState = path.join(__dirname, '.auth', 'aitops.json');

module.exports = defineConfig({
  testDir: './tests/e2e',
  timeout: 90_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  outputDir: 'test-results',
  use: {
    baseURL: process.env.AITOPS_BASE_URL || 'https://missioncontrol.qa.aitops.ai/',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    storageState: fs.existsSync(storageState) ? storageState : undefined,
    extraHTTPHeaders: accessHeaders(),
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});

function accessHeaders() {
  const clientId = process.env.AITOPS_ACCESS_CLIENT_ID;
  const clientSecret = process.env.AITOPS_ACCESS_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return {};
  }
  return {
    'CF-Access-Client-Id': clientId,
    'CF-Access-Client-Secret': clientSecret,
  };
}
