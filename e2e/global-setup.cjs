// Starts the stack once per run (unless E2E_BASE_URL is set) and warms the
// CDN cache used by fixtures.cjs.
const { execFileSync } = require("child_process");
const path = require("path");
const { ensurePackages } = require("../scripts/pw-cdn.cjs");

module.exports = async () => {
  ensurePackages();
  if (process.env.E2E_BASE_URL) return;
  const root = path.resolve(__dirname, "..");
  const url = execFileSync(
    path.join(root, "scripts/dev-stack.sh"),
    ["start", process.env.E2E_DB_PORT || "56100", process.env.E2E_API_PORT || "3200"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  ).trim();
  process.env.E2E_STARTED_STACK = "1";
  console.log(`[e2e] stack at ${url}`);
};
