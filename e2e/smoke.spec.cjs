// Smoke test for the e2e harness itself: the seeded clinic's login screen
// renders through the API-served dist/ with the CDN routes in place.
const { test, expect } = require("./fixtures.cjs");

test("clinic login screen renders", async ({ page }) => {
  await page.goto("/?org=demo-physio");
  await expect(page.locator("input[type=password]")).toBeVisible();
});
