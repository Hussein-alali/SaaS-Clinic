const { execFileSync } = require("child_process");
const path = require("path");

module.exports = async () => {
  if (process.env.E2E_BASE_URL || process.env.E2E_KEEP_STACK) return;
  execFileSync(
    path.resolve(__dirname, "../scripts/dev-stack.sh"),
    ["stop", process.env.E2E_DB_PORT || "56100", process.env.E2E_API_PORT || "3200"],
    { stdio: "inherit" },
  );
};
