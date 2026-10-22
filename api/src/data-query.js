'use strict';
// SQL for POST /api/data (the PostgREST replacement, docs/02-TRD.md).
// Identifiers are accepted only if they match IDENT_RE AND exist in the
// catalog (checked by the caller); they are then double-quoted. Every value
// is a bind parameter. No text from the request is ever spliced into SQL.

const { badRequest, forbidden } = require('./errors');

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const MAX_ROWS = 1000; // per response, as PostgREST's default "Max rows"
const MAX_WRITE_ROWS = 1000;
const MAX_FILTERS = 50;
const MAX_ORDER = 10;
const MAX_PARAMS = 65535;
const ACTIONS = new Set(['select', 'insert', 'update', 'upsert', 'delete']);
const OPS = {
  eq: '=',
  neq: '<>',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  like: 'like',
  ilike: 'ilike',
};

const qi = (name) => `"${name}"`; // only ever called on IDENT_RE-validated names
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isScalar = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v);
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function ident(name, code, what) {
  if (typeof name !== 'string' || !IDENT_RE.test(name)) {
    throw badRequest(code, `Invalid ${what}: must be a plain identifier`);
  }
  return name;
}

/** '*' | [col, ...] from "a, b,c". Anything else (expressions, aliases, embeds) → 400. */
function parseColumns(columns) {
  if (columns === undefined || columns === null) return '*';
  if (typeof columns !== 'string') throw badRequest('invalid_columns', 'columns must be a string');
  const s = columns.trim();
  if (s === '' || s === '*') return '*';
  const parts = s.split(',').map((p) => p.trim());
  if (parts.some((p) => !IDENT_RE.test(p))) {
    throw badRequest('invalid_columns', 'columns must be "*" or a comma-separated list of column names');
  }
  return [...new Set(parts)];
}

function parseFilters(filters) {
  if (filters === undefined || filters === null) return [];
  if (!Array.isArray(filters)) throw badRequest('invalid_filter', 'filters must be an array');
  if (filters.length > MAX_FILTERS) throw badRequest('invalid_filter', `At most ${MAX_FILTERS} filters`);
  return filters.map((f) => {
    if (!isPlainObject(f)) throw badRequest('invalid_filter', 'Each filter must be an object');
    const column = ident(f.column, 'invalid_filter', 'filter column');
    const op = f.op;
    if (typeof op !== 'string' || !(has(OPS, op) || op === 'is' || op === 'in')) {
      throw badRequest('invalid_filter', 'Unsupported filter operator');
    }
    const value = f.value;
    if (op === 'is') {
      const v = typeof value === 'string' ? value.toLowerCase() : value;
      if (v === null || v === 'null') return { column, op, value: null };
      if (v === true || v === 'true') return { column, op, value: true };
      if (v === false || v === 'false') return { column, op, value: false };
      throw badRequest('invalid_filter', '"is" accepts only null, true or false');
    }
    if (op === 'in') {
      if (!Array.isArray(value) || value.length > MAX_WRITE_ROWS) {
        throw badRequest('invalid_filter', '"in" needs an array of at most 1000 values');
      }
      return { column, op, value };
    }
    if (op === 'like' || op === 'ilike') {
      if (typeof value !== 'string') throw badRequest('invalid_filter', `"${op}" needs a string pattern`);
      return { column, op, value };
    }
    if (value === undefined) throw badRequest('invalid_filter', 'Filter value is required');
    return { column, op, value };
  });
}

function parseOrder(order) {
  if (order === undefined || order === null) return [];
  const list = Array.isArray(order) ? order : [order];
  if (list.length > MAX_ORDER) throw badRequest('invalid_order', `At most ${MAX_ORDER} order columns`);
  return list.map((o) => {
    if (!isPlainObject(o)) throw badRequest('invalid_order', 'Each order item must be an object');
    const column = ident(o.column, 'invalid_order', 'order column');
    for (const k of ['ascending', 'nullsFirst']) {
      if (o[k] !== undefined && o[k] !== null && typeof o[k] !== 'boolean') {
        throw badRequest('invalid_order', `${k} must be a boolean`);
      }
    }
    return { column, ascending: o.ascending !== false, nullsFirst: typeof o.nullsFirst === 'boolean' ? o.nullsFirst : null };
  });
}

/** {from, to} → {offset, limit}; limit is capped at MAX_ROWS. */
function parseRange(range) {
  if (range === undefined || range === null) return { offset: 0, limit: MAX_ROWS };
  if (!isPlainObject(range)) throw badRequest('invalid_range', 'range must be {from, to}');
  const { from, to } = range;
  if (!Number.isSafeInteger(from) || from < 0 || (to !== undefined && to !== null && (!Number.isSafeInteger(to) || to < from))) {
    throw badRequest('invalid_range', 'range needs integers 0 <= from <= to');
  }
  const limit = to === undefined || to === null ? MAX_ROWS : Math.min(to - from + 1, MAX_ROWS);
  return { offset: from, limit };
}

function parseEnum(value, allowed, code, what) {
  if (value === undefined || value === null || value === '' || value === 'null') return null;
  if (!allowed.includes(value)) throw badRequest(code, `Invalid ${what}`);
  return value;
}

/**
 * Validates the request body shape (not yet against the catalog).
 * Returns a normalized request with every identifier it references.
 */
function parseRequest(body) {
  if (!isPlainObject(body)) throw badRequest('invalid_request', 'Body must be a JSON object');
  const table = ident(body.table, 'invalid_table', 'table');
  const action = body.action === undefined ? 'select' : body.action;
  if (!ACTIONS.has(action)) throw badRequest('invalid_action', 'action must be select, insert, update, upsert or delete');
  const req = {
    table,
    action,
    columns: parseColumns(body.columns),
    filters: parseFilters(body.filters),
    order: parseOrder(body.order),
    range: parseRange(body.range),
    count: parseEnum(body.count, ['exact'], 'invalid_count', 'count (only "exact")'),
    single: parseEnum(body.single, ['single', 'maybeSingle'], 'invalid_single', 'single'),
    head: body.head === true,
    returning: body.returning === undefined || body.returning === null ? true : body.returning,
    ignoreDuplicates: body.ignoreDuplicates === true,
    values: body.values,
    onConflict: null,
  };
  if (typeof req.returning !== 'boolean') throw badRequest('invalid_request', 'returning must be a boolean');

  if (action === 'insert' || action === 'upsert') {
    const rows = Array.isArray(body.values) ? body.values : [body.values];
    if (!rows.length || rows.length > MAX_WRITE_ROWS || !rows.every(isPlainObject)) {
      throw badRequest('invalid_values', `values must be an object or an array of 1-${MAX_WRITE_ROWS} objects`);
    }
    for (const row of rows) for (const k of Object.keys(row)) ident(k, 'invalid_column', 'column');
    req.rows = rows;
  } else if (action === 'update') {
    if (!isPlainObject(body.values) || !Object.keys(body.values).length) {
      throw badRequest('invalid_values', 'update needs a non-empty values object');
    }
    for (const k of Object.keys(body.values)) ident(k, 'invalid_column', 'column');
    req.rows = [body.values];
  }
  if ((action === 'update' || action === 'delete') && !req.filters.length) {
    throw badRequest('filter_required', `${action} requires at least one filter`);
  }
  if (action === 'upsert' && body.onConflict !== undefined && body.onConflict !== null && body.onConflict !== '') {
    const list = Array.isArray(body.onConflict) ? body.onConflict : typeof body.onConflict === 'string' ? body.onConflict.split(',') : null;
    if (!list || !list.length) throw badRequest('invalid_on_conflict', 'onConflict must be a column list');
    req.onConflict = [...new Set(list.map((c) => ident(typeof c === 'string' ? c.trim() : c, 'invalid_on_conflict', 'onConflict column')))];
  }
  return req;
}

/** Every column name the request references (for the catalog check). */
function referencedColumns(req) {
  const names = new Set();
  if (Array.isArray(req.columns)) req.columns.forEach((c) => names.add(c));
  req.filters.forEach((f) => names.add(f.column));
  req.order.forEach((o) => names.add(o.column));
  (req.rows || []).forEach((r) => Object.keys(r).forEach((k) => names.add(k)));
  (req.onConflict || []).forEach((c) => names.add(c));
  return [...names];
}

/** JS value → bind parameter for a column (json/jsonb get JSON text). */
function bindValue(info, value, where) {
  if (value === null || value === undefined) return null;
  if (info && info.json) return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (info && info.array && value.every((v) => isScalar(v) || Array.isArray(v))) return value;
    throw badRequest('invalid_values', `Array value not allowed for ${where}`);
  }
  if (typeof value === 'object') throw badRequest('invalid_values', `Object value not allowed for ${where}`);
  return value;
}

class Params {
  constructor() {
    this.values = [];
  }
  add(v) {
    this.values.push(v);
    if (this.values.length > MAX_PARAMS) throw badRequest('invalid_request', 'Too many values in one request');
    return `$${this.values.length}`;
  }
}

function whereClause(req, meta, params) {
  if (!req.filters.length) return '';
  const parts = req.filters.map((f) => {
    const col = qi(f.column);
    const info = meta.columns.get(f.column);
    if (f.op === 'is') return `${col} is ${f.value === null ? 'null' : f.value ? 'true' : 'false'}`;
    if (f.op === 'in') {
      if (!info.json && !f.value.every(isScalar)) throw badRequest('invalid_filter', `"in" values for ${f.column} must be scalars`);
      return `${col} = any(${params.add(f.value.map((v) => bindValue(info, v, f.column)))})`;
    }
    if (!info.json && !info.array && !isScalar(f.value)) throw badRequest('invalid_filter', `Filter value for ${f.column} must be a scalar`);
    return `${col} ${OPS[f.op]} ${params.add(bindValue(info, f.value, f.column))}`;
  });
  return ` where ${parts.join(' and ')}`;
}

const target = (meta) => `public.${qi(meta.name)}`;
const selectList = (columns) => (columns === '*' ? '*' : columns.map(qi).join(', '));
const returningClause = (req) => (req.returning ? ` returning ${selectList(req.columns)}` : '');

/** organization_id in values must be the current organization (the WITH CHECK
 *  policy would refuse it too; this answers before touching the table). */
function checkOrganization(req, meta, orgId) {
  if (!meta.columns.has('organization_id')) return;
  for (const row of req.rows || []) {
    if (has(row, 'organization_id') && row.organization_id !== orgId) {
      throw forbidden('42501', 'organization_id must be the current organization');
    }
  }
}

function buildSelect(req, meta) {
  const params = new Params();
  const where = whereClause(req, meta, params);
  const countParams = params.values.slice();
  let order = '';
  if (req.order.length) {
    order = ` order by ${req.order
      .map((o) => `${qi(o.column)} ${o.ascending ? 'asc' : 'desc'}${o.nullsFirst === null ? '' : o.nullsFirst ? ' nulls first' : ' nulls last'}`)
      .join(', ')}`;
  }
  let limit = req.range.limit;
  if (req.single) limit = Math.min(limit, 2); // enough to detect "more than one row"
  const sql = `select ${selectList(req.columns)} from ${target(meta)}${where}${order} limit ${params.add(limit)} offset ${params.add(req.range.offset)}`;
  return {
    sql,
    params: params.values,
    countSql: `select count(*) as count from ${target(meta)}${where}`,
    countParams,
  };
}

function valuesClause(req, meta, params) {
  const cols = [];
  for (const row of req.rows) for (const k of Object.keys(row)) if (!cols.includes(k)) cols.push(k);
  for (const c of cols) {
    if (meta.columns.get(c).generated) throw badRequest('invalid_column', `Column ${c} is generated and cannot be written`);
  }
  const tuples = req.rows.map(
    (row) => `(${cols.map((c) => (has(row, c) ? params.add(bindValue(meta.columns.get(c), row[c], c)) : 'default')).join(', ')})`,
  );
  return { cols, tuples };
}

function buildInsert(req, meta) {
  const params = new Params();
  const { cols, tuples } = valuesClause(req, meta, params);
  let sql;
  if (!cols.length) {
    if (req.rows.length !== 1) throw badRequest('invalid_values', 'Rows without columns can only be inserted one at a time');
    sql = `insert into ${target(meta)} default values`;
  } else {
    sql = `insert into ${target(meta)} (${cols.map(qi).join(', ')}) values ${tuples.join(', ')}`;
  }
  if (req.action === 'upsert') {
    const conflict = req.onConflict || meta.pk;
    if (!conflict.length) throw badRequest('invalid_on_conflict', 'Table has no primary key; pass onConflict');
    const updates = cols.filter((c) => !conflict.includes(c));
    sql += ` on conflict (${conflict.map(qi).join(', ')})`;
    sql += req.ignoreDuplicates || !updates.length
      ? ' do nothing'
      : ` do update set ${updates.map((c) => `${qi(c)} = excluded.${qi(c)}`).join(', ')}`;
  }
  return { sql: sql + returningClause(req), params: params.values };
}

function buildUpdate(req, meta) {
  const params = new Params();
  const values = req.rows[0];
  const sets = Object.keys(values).map((c) => {
    if (meta.columns.get(c).generated) throw badRequest('invalid_column', `Column ${c} is generated and cannot be written`);
    return `${qi(c)} = ${params.add(bindValue(meta.columns.get(c), values[c], c))}`;
  });
  const where = whereClause(req, meta, params);
  return { sql: `update ${target(meta)} set ${sets.join(', ')}${where}${returningClause(req)}`, params: params.values };
}

function buildDelete(req, meta) {
  const params = new Params();
  const where = whereClause(req, meta, params);
  return { sql: `delete from ${target(meta)}${where}${returningClause(req)}`, params: params.values };
}

function buildQuery(req, meta) {
  switch (req.action) {
    case 'select':
      return buildSelect(req, meta);
    case 'insert':
    case 'upsert':
      return buildInsert(req, meta);
    case 'update':
      return buildUpdate(req, meta);
    case 'delete':
      return buildDelete(req, meta);
    default:
      throw badRequest('invalid_action', 'Unsupported action');
  }
}

module.exports = {
  IDENT_RE,
  MAX_ROWS,
  MAX_WRITE_ROWS,
  isPlainObject,
  parseRequest,
  referencedColumns,
  checkOrganization,
  buildQuery,
  bindValue,
};
