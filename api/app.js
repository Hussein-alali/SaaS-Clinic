'use strict';
// ClinicSystem EG API entry point. hosting.com cPanel → Setup Node.js App:
// application root = api, startup file = app.js. Passenger loads this file
// and intercepts listen(); `npm start` / `node app.js` listens on PORT.
// Exports the Express app (tests use src/create-app.js directly).

const { loadConfig } = require('./src/config');
const { createApp } = require('./src/create-app');

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
}
