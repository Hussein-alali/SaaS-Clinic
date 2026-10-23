'use strict';
// What /api/data and /api/rpc may touch, read from the database catalog and
// cached. A name that is not in the cache triggers one refresh (throttled),
// so a migration applied while the API runs is picked up without a restart.

// Platform and identity tables (docs/05-Backend-Schema.md convention 4) are
// never exposed through /api/data, even if one of them were given RLS by
// mistake. auth.* is outside `public` and therefore never listed at all.
const EXCLUDED_TABLES = new Set([
  'schema_migrations',
  'organizations',
  'organization_members',
  'member_branches',
  'platform_admins',
  'invitations',
  'specialties',
  'modules',
  'specialty_modules',
  'organization_modules',
  'subscription_plans',
  'subscriptions',
  'reserved_slugs',
]);

const TABLES_SQL = `
  select c.relname as table_name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r', 'p')
     and c.relrowsecurity and c.relforcerowsecurity`;

const COLUMNS_SQL = `
  select table_name, column_name, data_type, udt_name, is_generated
    from information_schema.columns
   where table_schema = 'public'
   order by table_name, ordinal_position`;

const PK_SQL = `
  select tc.relname as table_name, a.attname as column_name
    from pg_index i
    join pg_class tc on tc.oid = i.indrelid
    join pg_namespace n on n.oid = tc.relnamespace
    cross join lateral unnest(i.indkey::int2[]) with ordinality as k(attnum, ord)
    join pg_attribute a on a.attrelid = tc.oid and a.attnum = k.attnum
   where i.indisprimary and n.nspname = 'public'
   order by tc.relname, k.ord`;

class TableCatalog {
  constructor(db, { minRefreshMs = 5000 } = {}) {
    this.db = db;
    this.minRefreshMs = minRefreshMs;
    this.tables = null; // Map<name, {name, columns: Map<col, info>, pk: string[]}>
    this.loadedAt = 0;
    this.loading = null;
  }

  async load() {
    const [tables, columns, pks] = await Promise.all([
      this.db.query(TABLES_SQL),
      this.db.query(COLUMNS_SQL),
      this.db.query(PK_SQL),
    ]);
    const map = new Map();
    for (const { table_name: name } of tables.rows) {
      if (!EXCLUDED_TABLES.has(name)) map.set(name, { name, columns: new Map(), pk: [] });
    }
    for (const c of columns.rows) {
      const t = map.get(c.table_name);
      if (!t) continue;
      t.columns.set(c.column_name, {
        name: c.column_name,
        dataType: c.data_type,
        udtName: c.udt_name,
        json: c.udt_name === 'json' || c.udt_name === 'jsonb',
        array: c.data_type === 'ARRAY',
        generated: c.is_generated === 'ALWAYS',
      });
    }
    for (const p of pks.rows) {
      const t = map.get(p.table_name);
      if (t) t.pk.push(p.column_name);
    }
    this.tables = map;
    this.loadedAt = Date.now();
  }

  /** Reloads unless a load happened less than minRefreshMs ago. */
  async refresh(force = false) {
    if (this.loading) {
      await this.loading;
      return true;
    }
    if (!force && this.tables && Date.now() - this.loadedAt < this.minRefreshMs) return false;
    this.loading = this.load().finally(() => {
      this.loading = null;
    });
    await this.loading;
    return true;
  }

  /** Whitelisted table metadata, or null. */
  async getTable(name) {
    if (!this.tables) await this.refresh(true);
    let t = this.tables.get(name);
    if (!t && (await this.refresh())) t = this.tables.get(name);
    return t || null;
  }

  /** Column names of `table` that do not exist (after one refresh on a miss). */
  async missingColumns(tableName, names) {
    let t = await this.getTable(tableName);
    if (!t) return names.slice();
    let missing = names.filter((n) => !t.columns.has(n));
    if (missing.length && (await this.refresh())) {
      t = this.tables.get(tableName);
      missing = t ? names.filter((n) => !t.columns.has(n)) : names.slice();
    }
    return missing;
  }
}

const FUNCTIONS_SQL = `
  select p.oid, p.proretset as retset, p.pronargs as nargs, p.pronargdefaults as ndefaults,
         coalesce(p.proargnames, '{}'::text[]) as argnames,
         coalesce(p.proargmodes::text[], '{}'::text[]) as argmodes,
         array(select format_type(t.oid, null)
                 from unnest(p.proargtypes::oid[]) with ordinality as u(oid, ord)
                 join pg_type t on t.oid = u.oid
                order by u.ord) as argtypes,
         format_type(p.prorettype, null) as rettype,
         rt.typtype as rettypkind
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_type rt on rt.oid = p.prorettype
   where n.nspname = 'public' and p.proname = $1 and p.prokind = 'f'`;

/** Overloads of public.<name>, cached for ttlMs. Input arguments only. */
class FunctionCatalog {
  constructor(db, { ttlMs = 30000 } = {}) {
    this.db = db;
    this.ttlMs = ttlMs;
    this.cache = new Map();
  }

  async get(name, { fresh = false } = {}) {
    const hit = this.cache.get(name);
    if (!fresh && hit && Date.now() - hit.at < this.ttlMs) return hit.defs;
    const { rows } = await this.db.query(FUNCTIONS_SQL, [name]);
    const defs = rows.map((r) => {
      // proargnames/proargmodes list every argument (OUT too) when modes
      // exist; proargtypes lists the input arguments only, in order.
      const modes = r.argmodes.length ? r.argmodes : r.argnames.map(() => 'i');
      const inputNames = r.argnames.filter((_, i) => ['i', 'b', 'v'].includes(modes[i] || 'i'));
      const args = r.argtypes.map((type, i) => ({ name: inputNames[i] || null, type }));
      return {
        oid: r.oid,
        args,
        required: args.slice(0, args.length - r.ndefaults),
        retset: r.retset,
        rettype: r.rettype,
        composite: r.rettypkind === 'c' || r.rettype === 'record',
        isVoid: r.rettype === 'void',
        variadic: modes.includes('v'),
      };
    });
    if (defs.length) this.cache.set(name, { at: Date.now(), defs });
    else this.cache.delete(name);
    return defs;
  }
}

module.exports = { EXCLUDED_TABLES, TableCatalog, FunctionCatalog };
