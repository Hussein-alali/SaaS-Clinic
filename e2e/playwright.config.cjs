// Browser tests for the user journeys (docs/03-App-Flow.md, docs/06 task 3.9).
//
//   npx playwright test -c e2e/playwright.config.cjs [e2e/<file>.spec.cjs]
//
// globalSetup starts the whole stack with scripts/dev-stack.sh on
// E2E_DB_PORT / E2E_API_PORT (defaults 56100 / 3200), from a freshly reset
// and seeded database, unless E2E_BASE_URL points at a running app.
// Use distinct ports when several runs share one machine.
const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: __dirname,
  testMatch: /.*\.spec\.cjs$/,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  globalSetup: require.resolve("./global-setup.cjs"),
  globalTeardown: require.resolve("./global-teardown.cjs"),
  use: {
    baseURL: process.env.E2E_BASE_URL || `http://localhost:${process.env.E2E_API_PORT || 3200}`,
    locale: "ar-EG",
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  // Per API port, so parallel runs on one machine do not delete each other's traces.
  outputDir: `/tmp/clinicsys-e2e-results-${process.env.E2E_API_PORT || 3200}`,
});
