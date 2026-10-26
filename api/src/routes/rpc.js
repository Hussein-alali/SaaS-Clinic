'use strict';
// POST /api/rpc/:fn {args:{...}} — calls a whitelisted public function with
// named arguments inside withContext(req.ctx). Result shape follows
// PostgREST: the value for a scalar function, an array for set-returning
// functions, an object for a function returning one composite row.

const express = require('express');
const auth = require('../auth');
const { badRequest, notFound } = require('../errors');
const { requireOrg } = require('../tenant');
const { RPC_WHITELIST } = require('../rpc-whitelist');
const { IDENT_RE, isPlainObject } = require('../data-query');
const { assertModule, rpcModule } = require('../modules');
const { idempotencyKey, withIdempotency } = require('../idempotency');

const router = express.Router();

const isJsonType = (type) => type === 'json' || type === 'jsonb';

// Arguments the server fills in, whatever the client sent (CWE-501): a
// payment's IP address is the request's (Express "trust proxy", TRUST_PROXY).
const SERVER_ARGS = {
  record_quick_payment: { p_ip_address: (req) => auth.clientIp(req) },
};

function bindArg(arg, value) {
  if (value === null || value === undefined) return null;
  if (isJsonType(arg.type)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (arg.type.endsWith('[]')) return value;
    throw badRequest('invalid_args', `Argument ${arg.name} does not take an array`);
  }
  if (typeof value === 'object') throw badRequest('invalid_args', `Argument ${arg.name} does not take an object`);
  return value;
}

/** The overload whose input names cover `keys` and whose required names are all given. */
function pickOverload(defs, keys) {
  const fits = defs.filter((d) => {
    if (d.variadic) return false;
    const names = d.args.map((a) => a.name);
    return keys.every((k) => names.includes(k)) && d.required.every((a) => a.name && keys.includes(a.name));
  });
  if (fits.length <= 1) return fits[0] || null;
  const exact = fits.filter((d) => d.args.length === keys.length);
  if (exact.length === 1) return exact[0];
  throw badRequest('ambiguous_function', 'More than one function matches these argument names');
}

router.post('/:fn', requireOrg(), async (req, res) => {
  const { db, functions } = req.app.locals;
  const fn = req.params.fn;
  if (!RPC_WHITELIST.has(fn) || !IDENT_RE.test(fn)) throw notFound('rpc_not_allowed', `Function ${fn} is not available`);
  // A function of a module the clinic has not enabled (AT-07): 403.
  await assertModule(db, req.ctx.orgId, rpcModule(fn));

  const body = req.body === undefined ? {} : req.body;
  if (!isPlainObject(body)) throw badRequest('invalid_request', 'Body must be a JSON object');
  const args = body.args === undefined || body.args === null ? {} : body.args;
  if (!isPlainObject(args)) throw badRequest('invalid_args', 'args must be an object');
  for (const [name, value] of Object.entries(SERVER_ARGS[fn] || {})) args[name] = value(req);
  const keys = Object.keys(args);
  for (const k of keys) {
    if (!IDENT_RE.test(k)) throw badRequest('invalid_args', 'Argument names must be plain identifiers');
  }

  let defs = await functions.get(fn);
  let def = defs.length ? pickOverload(defs, keys) : null;
  if (!def) {
    // The function may have changed since it was cached.
    defs = await functions.get(fn, { fresh: true });
    if (!defs.length) throw notFound('function_not_found', `Function ${fn} does not exist`);
    def = pickOverload(defs, keys);
  }
  if (!def) {
    const expected = defs.map((d) => `(${d.args.map((a) => a.name).join(', ')})`).join(' or ');
    throw badRequest('invalid_args', `Arguments do not match ${fn}${expected}`);
  }

  const params = [];
  const call = `public."${fn}"(${keys
    .map((k) => {
      const arg = def.args.find((a) => a.name === k);
      params.push(bindArg(arg, args[k]));
      return `"${k}" => $${params.length}::${arg.type}`;
    })
    .join(', ')})`;

  const run = async (client) => {
    if (def.retset) {
      if (def.composite) return (await client.query(`select * from ${call}`, params)).rows;
      return (await client.query(`select ${call} as value`, params)).rows.map((r) => r.value);
    }
    if (def.composite) {
      // to_jsonb keeps a NULL row as null (select * would give all-null columns)
      // and formats values the way PostgREST does.
      const { rows } = await client.query(`select to_jsonb(${call}) as value`, params);
      return rows[0].value;
    }
    const { rows } = await client.query(`select ${call} as value`, params);
    return def.isVoid ? null : rows[0].value;
  };

  // Idempotency-Key (a quick payment retried after a timeout or clicked
  // twice): one call per key, the repeat gets the stored answer.
  const key = idempotencyKey(req);
  const result = await db.withContext(req.ctx, (client) => (key
    ? withIdempotency(client, { scope: `rpc:${fn}`, key, orgId: req.ctx.orgId, userId: req.ctx.userId },
      async () => ({ status: 200, body: await run(client) }))
    : run(client).then((body) => ({ status: 200, body }))));
  if (result.replayed) res.set('Idempotency-Replayed', 'true');
  res.status(result.status).json(result.body);
});

module.exports = router;
