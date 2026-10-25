#!/usr/bin/env node
'use strict';
// Runs the due background jobs (docs/06 S7, src/jobs.js), then exits.
// cPanel → Cron Jobs, every minute (docs/08 Runbook):
//
//   * * * * *  cd ~/clinicsys/current/api && node scripts/run-jobs.js >> ~/clinicsys-jobs.log 2>&1
//
// Queues the day's maintenance once, then drains due jobs for at most
// JOBS_MAX_SECONDS (55), so two cron runs never overlap for long (and
// SKIP LOCKED keeps them apart when they do). Same environment as the app
// (DATABASE_URL, SMTP_*, APP_BASE_DOMAIN...). Exit 0 when the run went
// through (failed jobs included: they are retried later), 1 when it could
// not run at all (configuration, database).

const { loadConfig } = require('../src/config');
const { createDb } = require('../src/db');
const { createMailer } = require('../src/mailer');
const jobs = require('../src/jobs');
const { queueDaily } = require('../src/job-handlers');

async function main() {
  const config = loadConfig();
  const db = createDb(config);
  const deps = { config, db, mailer: createMailer(config) };
  const until = Date.now() + Number(process.env.JOBS_MAX_SECONDS || 55) * 1000;
  const total = { done: 0, retried: 0, failed: 0 };
  try {
    await queueDaily(db);
    while (Date.now() < until) {
      const r = await jobs.runDue(db, { deps, workerId: `cron:${process.pid}` });
      for (const k of Object.keys(total)) total[k] += r[k];
      if (!r.done && !r.retried && !r.failed) break;
    }
  } finally {
    await db.close();
  }
  console.log(`${new Date().toISOString()} jobs: ${total.done} done, ${total.retried} retried, ${total.failed} failed`);
}

main().then(() => { process.exitCode = 0; }, (err) => {
  console.error(`run-jobs: ${err && err.message}`);
  process.exitCode = 1;
});
