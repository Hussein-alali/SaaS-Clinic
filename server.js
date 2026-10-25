// Minimal zero-dependency static server for Railway (or any Node host).
// The app itself is fully static, so all this does is serve files on the
// port the platform provides. It serves the precompiled build in dist/
// (`npm run build`) when one exists; `npm run dev` serves the raw sources
// instead — index.html + src/*.jsx compiled by Babel Standalone in the
// browser — so edits show up on reload without a build step.
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const DEV = process.argv.includes("--dev");
const DIST = path.join(__dirname, "dist");
const ROOT = !DEV && fs.existsSync(path.join(DIST, "index.html")) ? DIST : __dirname;
// The repository root (--dev, or no dist/ yet) holds more than the app:
// seed-admin.sql, DEPLOY.md, .git/, api/.env... From it only the app's own
// files are served; a dotfile never, in either mode (test/server.test.mjs).
const APP_PATHS = /^\/(?:index\.html$|src\/|assets\/)/;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".jsx": "text/babel; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".sql": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
};

http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  } catch {
    res.writeHead(400); return res.end("Bad request");
  }
  if (urlPath === "/") urlPath = "/index.html";
  if (urlPath.split(/[\\/]/).some((seg) => seg.startsWith(".")) || (ROOT !== DIST && !APP_PATHS.test(urlPath))) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Not found");
  }

  const filePath = path.join(ROOT, path.normalize(urlPath));
  // Never serve outside the project root.
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); return res.end("Forbidden");
  }

  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Not found");
    }
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    fs.createReadStream(filePath).pipe(res);
  });
}).listen(PORT, () => {
  console.log(`Kinetic clinic app serving ${ROOT === DIST ? "dist/ (production build)" : "sources (dev, in-browser Babel)"} on port ${PORT}`);
});
