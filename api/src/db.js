'use strict';
// PostgreSQL access. One Pool (max 10 connections: shared hosting limits
// processes and connections) and withContext(), which runs a callback inside
// a transaction whose request context is set with set_config(..., true), so
// RLS (FORCE ROW LEVEL SECURITY on every clinic table) sees the caller.
// See docs/05-Backend-Schema.md, conventions 3 and 6-8.

const { Pool, types } = require('pg');

// Result values follow PostgREST/supabase-js JSON, which the frontend was
// written against: int8/numeric are numbers, date stays 'YYYY-MM-DD' (no
// local-midnight Date shift), timestamps are ISO-8601 strings.
function isoTimestamp(withZone) {
  return (v) => {
    if (v === 'infinity' || v === '-infinity') return v;
    let s = v.replace(' ', 'T');
    if (withZone) s = s.replace(/([+-]\d\d)$/, '$1:00');
    return s;
  };
}
const toNumber = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && (Number.isSafeInteger(n) || !/^-?\d+$/.test(v)) ? n : v;
};
const identity = (v) => v;
const SCALAR_PARSERS = {
  20: toNumber, // int8
  1700: toNumber, // numeric
  1082: identity, // date
  1083: identity, // time
  1114: isoTimestamp(false), // timestamp
  1184: isoTimestamp(true), // timestamptz
};
const ARRAY_OF = { 1016: 20, 1231: 1700, 1182: 1082, 1183: 1083, 1115: 1114, 1185: 1184 };

function getTypeParser(oid, format) {
  if (format !== 'binary') {
    if (SCALAR_PARSERS[oid]) return SCALAR_PARSERS[oid];
    if (ARRAY_OF[oid]) {
      const inner = SCALAR_PARSERS[ARRAY_OF[oid]];
      return (v) => types.arrayParser.create(v, (x) => (x === null ? null : inner(x))).parse();
    }
  }
  return types.getTypeParser(oid, format);
}

function createDb(config) {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: config.dbPoolMax || 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    types: { getTypeParser },
    // Same time zone Supabase used (UTC); bounded statements and idle
    // transactions so one bad request cannot hold a shared-hosting slot.
    options: `-c TimeZone=UTC -c statement_timeout=${config.dbStatementTimeoutMs || 15000} -c idle_in_transaction_session_timeout=60000`,
  });
  // An idle client losing its connection must not crash the process.
  pool.on('error', (err) => console.error('[db] idle client error:', err.message));

  // Statements sent on any pooled connection (pool.query goes through
  // client.query too). queryCount() is the test hook of docs/06 S9: a list
  // endpoint runs as many statements for 3 rows as for 60 (no N+1).
  let statements = 0;
  pool.on('connect', (client) => {
    const send = client.query;
    client.query = function countedQuery(...args) {
      statements += 1;
      return send.apply(this, args);
    };
  });
  const queryCount = () => statements;

  const query = (text, params) => pool.query(text, params);

  /**
   * Runs fn(client) inside BEGIN ... COMMIT with the request context set
   * transaction-locally:
   *   app.user_id, app.org_id, app.branch_id, app.system ('on' | 'off').
   * Any error rolls back and is re-thrown.
   */
  async function withContext(ctx, fn) {
    const c = ctx || {};
    const client = await pool.connect();
    let releaseErr;
    try {
      await client.query('BEGIN');
      await client.query(
        `select set_config('app.user_id', $1, true), set_config('app.org_id', $2, true),
                set_config('app.branch_id', $3, true), set_config('app.system', $4, true)`,
        [c.userId || '', c.orgId || '', c.branchId || '', c.system ? 'on' : 'off'],
      );
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        releaseErr = rollbackErr; // connection is unusable: destroy it
      }
      throw err;
    } finally {
      client.release(releaseErr);
    }
  }

  const close = () => pool.end();

  return { pool, query, withContext, close, queryCount };
}

module.exports = { createDb, getTypeParser };
