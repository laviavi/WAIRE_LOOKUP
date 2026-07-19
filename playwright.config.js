const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests_e2e',
  timeout: 30000,
  use: {
    baseURL: 'http://127.0.0.1:2305',
    browserName: 'chromium',
  },
  webServer: {
    command: 'python waire_lookup/app.py',
    port: 2305,
    reuseExistingServer: true,
    timeout: 15000,
  },
});
