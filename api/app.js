'use strict';
// ClinicSystem EG API entry point. hosting.com cPanel → Setup Node.js App:
// application root = api, startup file = app.js. Passenger loads this file
// and intercepts listen(); `npm start` / `node app.js` listens on PORT.
// Exports the Express app (tests use src/create-app.js directly).

const { loadConfig } = require('./src/config');
const { createApp } = require('./src/create-app');
const { recordError } = require('./src/errorlog');
const jobs = require('./src/jobs');
const { queueScheduled } = require('./src/job-handlers');

/* global PhusionPassenger */
const underPassenger =
  typeof PhusionPassenger !== 'undefined' || !!process.env.PASSENGER_APP_ENV || !!process.env.IN_PASSENGER;
const runDirectly = require.main === module || underPassenger;

let config;
try {
  config = loadConfig();
} catch (err) {
  // Production without JWT_SECRET / FILES_SIGNING_SECRET / DATABASE_URL.
  console.error(err.message);
  if (runDirectly) process.exit(1);
  throw err;
}

const app = createApp(config);
module.exports = app;

if (runDirectly) {
  const server = app.listen(config.port, () => {
    console.log(`ClinicSystem API listening on port ${config.port} (${config.nodeEnv}); static files from ${config.distDir}`);
  });
  const shutdown = (signal) => {
    console.log(`${signal} received, closing`);
    server.close(() => {
      app.locals
        .close()
        .catch((err) => console.error('close failed:', err.message))
        .finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(0), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Background jobs (docs/06 S7): every JOBS_POLL_MS (10 s; 0 = off) while
  // this process lives. Passenger stops idle processes, so cron runs
  // scripts/run-jobs.js every minute as well; SKIP LOCKED keeps them apart.
  const pollMs = Number(process.env.JOBS_POLL_MS || 10000);
  if (pollMs > 0) {
    let busy = false;
    setInterval(() => {
      if (busy) return;
      busy = true;
      queueScheduled(app.locals.db)
        .then(() => jobs.runDue(app.locals.db, { deps: app.locals }))
        .catch((err) => console.error('[api] jobs:', err.message))
        .finally(() => { busy = false; });
    }, pollMs).unref();
  }

  // Errors outside a request (a timer, a background task) reach the
  // platform's error list too (docs/06 S6). After an uncaught exception the
  // process is in an unknown state: record it, then exit (Passenger starts
  // a new one).
  const record = (err, route) => recordError(app.locals.db, {
    source: 'api', message: (err && err.message) || String(err), stack: err && err.stack, route, release: config.release,
  });
  process.on('unhandledRejection', (err) => {
    console.error('[api] unhandled rejection:', err && (err.stack || err));
    record(err, 'process:unhandledRejection');
  });
  process.on('uncaughtException', (err) => {
    console.error('[api] uncaught exception:', err && (err.stack || err));
    setTimeout(() => process.exit(1), 3000).unref();
    record(err, 'process:uncaughtException').finally(() => process.exit(1));
  });
}
