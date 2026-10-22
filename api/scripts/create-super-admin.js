#!/usr/bin/env node
'use strict';
// Creates a Super Admin, or promotes an existing account to Super Admin
// (docs/05-Backend-Schema.md "platform_admins": managed only by this script
// or by SQL — no API route writes platform_admins).
//
//   DATABASE_URL=postgres://... node api/scripts/create-super-admin.js \
//       --email owner@example.com --password '<password>' [--name 'Owner']
//
//   --password-stdin   read the password from standard input instead
//                      (keeps it out of the shell history and `ps`)
//
// New e-mail: an active account with this bcrypt password (cost 10) and a
// row in platform_admins. Existing account: re-activated, password replaced
// when one is given (every open session ends), name set when --name is
// given, and the platform_admins row added if missing. The change is
// written to audit_events (platform event). Exit code 0 on success, 1 on
// any error. Run it from cPanel → Terminal (or SSH) with the app's
// DATABASE_URL; it uses api/node_modules (run "npm install" in api/ first).

const path = require('path');
const { Client } = require('pg');
const auth = require(path.join(__dirname, '..', 'src', 'auth'));
const { isValidEmail } = require(path.join(__dirname, '..', 'src', 'mailer'));
const { writeAudit } = require(path.join(__dirname, '..', 'src', 'audit'));

const USAGE = 'usage: node api/scripts/create-super-admin.js --email <email> (--password <password> | --password-stdin) [--name <name>]';
const DEV_DATABASE_URL = 'postgres://clinic_owner:clinic_owner_dev@127.0.0.1:54329/clinicsys';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!m) throw new Error(`unexpected argument "${arg}"`);
    const key = m[1];
    if (key === 'password-stdin' || key === 'help') {
      out[key] = true;
      continue;
    }
    if (!['email', 'password', 'name'].includes(key)) throw new Error(`unknown option --${key}`);
    const value = m[2] !== undefined ? m[2] : argv[(i += 1)];
    if (value === undefined) throw new Error(`--${key} needs a value`);
    out[key] = value;
  }
  return out;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      data += c;
    });
    process.stdin.on('end', () => resolve(data.replace(/\r?\n$/, '')));
    process.stdin.on('error', reject);
  });
}

async function createSuperAdmin({ databaseUrl, email, password, name }) {
  const client = new Client({ connectionString: databaseUrl, application_name: 'clinicsys-create-super-admin' });
  await client.connect();
  try {
    await client.query("set TimeZone = 'UTC'");
    await client.query('begin');
    // audit_events has FORCE ROW LEVEL SECURITY: write it in the system context.
    await client.query("select set_config('app.system', 'on', true)");
    const hash = password ? await auth.hashPassword(password) : null;
    const { rows: found } = await client.query(
      'select id, email, status from auth.users where lower(email) = lower($1) for update',
      [email],
    );
    let user = found[0];
    let action;
    if (user) {
      const { rows } = await client.query(
        `update auth.users
            set status = 'active',
                encrypted_password = coalesce($2, encrypted_password),
                session_version = session_version + case when $2::text is null then 0 else 1 end,
                raw_user_meta_data = case when $3::text is null then raw_user_meta_data
                                          else coalesce(raw_user_meta_data, '{}'::jsonb) || jsonb_build_object('name', $3::text) end,
                updated_at = now()
          where id = $1
          returning id, email`,
        [user.id, hash, name || null],
      );
      user = rows[0];
      action = 'promoted';
    } else {
      if (!hash) throw new Error('a new account needs --password (or --password-stdin)');
      const { rows } = await client.query(
        `insert into auth.users (email, encrypted_password, raw_user_meta_data, status, email_confirmed_at)
         values ($1, $2, case when $3::text is null then '{}'::jsonb else jsonb_build_object('name', $3::text) end, 'active', now())
         returning id, email`,
        [email, hash, name || null],
      );
      user = rows[0];
      action = 'created';
    }
    const grant = await client.query(
      'insert into public.platform_admins (user_id) values ($1) on conflict (user_id) do nothing',
      [user.id],
    );
    if (action === 'promoted' && grant.rowCount === 0) action = 'updated';
    await writeAudit(client, {
      orgId: null,
      actorUid: null,
      actorRole: 'cli',
      action: action === 'created' ? 'platform_admin.create' : 'platform_admin.grant',
      tableName: 'platform_admins',
      rowPk: user.id,
      targetType: 'user',
      targetId: user.id,
      payload: { email: user.email, result: action, password_set: !!hash, by: 'api/scripts/create-super-admin.js' },
    });
    await client.query('commit');
    return { action, user };
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err.message}\n${USAGE}`);
    return 1;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  const email = typeof args.email === 'string' ? args.email.trim().toLowerCase() : '';
  if (!isValidEmail(email)) {
    console.error(`--email must be a valid e-mail address\n${USAGE}`);
    return 1;
  }
  let password = args.password;
  if (args['password-stdin']) password = await readStdin();
  if (password !== undefined) {
    try {
      auth.validatePassword(password);
    } catch (err) {
      console.error(`--password: ${err.message}`);
      return 1;
    }
  }
  const name = typeof args.name === 'string' && args.name.trim() ? args.name.trim().slice(0, 120) : null;
  const databaseUrl = process.env.DATABASE_URL || (process.env.NODE_ENV === 'production' ? '' : DEV_DATABASE_URL);
  if (!databaseUrl) {
    console.error('DATABASE_URL is required');
    return 1;
  }
  try {
    const { action, user } = await createSuperAdmin({ databaseUrl, email, password, name });
    console.log(`Super Admin ${action}: ${user.email} (${user.id})`);
    return 0;
  } catch (err) {
    console.error(`create-super-admin failed: ${err.message}`);
    return 1;
  }
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  });
}

module.exports = { createSuperAdmin, parseArgs };
