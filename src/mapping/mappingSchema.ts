import { z } from 'zod';
import type { ColumnMapping } from '../types.js';
import identifierSchema from './identifierSchema.js';
import timeZoneSchema from './timeZoneSchema.js';

/** Dot path ("data.request_input.page"); a numeric segment indexes an array; "." (children only) is the element itself. */
const sourcePath = z.string().min(1).regex(/^(\.|[^$.][^$]*)$/).refine((p) => p === '.' || p.split('.').every(Boolean), 'empty path segment');
const sqlType = z.string().regex(/^[A-Za-z]+(\(\d+(,\d+)?\))?( UNSIGNED)?$/i, 'like VARCHAR(255), DECIMAL(13,2), DATETIME(3)');

const column = z.strictObject({
  column: identifierSchema, source: sourcePath,
  cast: z.enum(['string', 'int', 'bigint', 'double', 'decimal', 'bool', 'datetime', 'objectId', 'json']),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(), // when missing or null
  fsp: z.number().int().min(0).max(6).optional(),    // datetime: digits written (truncated), default 0
  timezone: timeZoneSchema.optional(),                // datetime: wall-clock zone, default "UTC"
  round: z.enum(['reject', 'half-up']).optional(),    // decimal: digits beyond the column scale, default reject
  sqlType: sqlType.optional(),                        // DDL hint for --create-tables and infer's .sql only
  note: z.string().optional(),
});

const child = z.strictObject({
  table: identifierSchema, source: sourcePath,              // source: array in the parent
  parentColumn: identifierSchema,                           // parent key value
  indexColumn: identifierSchema.nullable().default(null),   // array position (0-based)
  columns: z.array(column).min(1),                          // sources relative to the element
});

type Issue = { path: (string | number)[]; message: string };

/** A decimal literal: what `default` may hold for a `decimal` column, so the value reaches MySQL unparsed. */
const decimalLiteral = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

/** Rule 3: the JSON type of `default` must match what the cast would produce. */
function defaultIssue(c: ColumnMapping, path: (string | number)[]): Issue | null {
  if (c.default === undefined) return null;
  const t = typeof c.default;
  const at = [...path, 'default'];
  switch (c.cast) {
    case 'string': return t === 'string' ? null : { path: at, message: 'must be a string for cast string' };
    case 'decimal':
      return t === 'string' && decimalLiteral.test(c.default as string) ? null : { path: at, message: 'must be a decimal literal string for cast decimal' };
    case 'int': case 'bigint':
      return Number.isInteger(c.default) ? null : { path: at, message: `must be an integer for cast ${c.cast}` };
    case 'double': return t === 'number' ? null : { path: at, message: 'must be a number for cast double' };
    case 'bool': return t === 'boolean' ? null : { path: at, message: 'must be a boolean for cast bool' };
    default: return { path: at, message: `not allowed for cast ${c.cast}` };
  }
}

/** Rule 4: cast-specific options only on their cast. */
function optionIssues(c: ColumnMapping, path: (string | number)[]): Issue[] {
  const issues: Issue[] = [];
  if (c.cast !== 'datetime') {
    if (c.fsp !== undefined) issues.push({ path: [...path, 'fsp'], message: 'only for cast datetime' });
    if (c.timezone !== undefined) issues.push({ path: [...path, 'timezone'], message: 'only for cast datetime' });
  }
  if (c.cast !== 'decimal' && c.round !== undefined) issues.push({ path: [...path, 'round'], message: 'only for cast decimal' });
  return issues;
}

/**
 * Rule 2: a source may not equal or sit on the path of another, so no value feeds two columns. `_id` is the
 * document key and is banned as a parent source; inside a child it is the element's own field (Mongoose
 * gives array subdocuments one by default) and may be mapped.
 */
function sourceIssues(sources: { source: string; path: (string | number)[] }[], allowDot: boolean): Issue[] {
  const issues: Issue[] = [];
  sources.forEach((a, i) => {
    if (a.source === '.') {
      if (!allowDot) issues.push({ path: a.path, message: '"." is only valid inside children' });
      return;
    }
    if (!allowDot && (a.source === '_id' || a.source.startsWith('_id.'))) issues.push({ path: a.path, message: 'must not start with _id: the key covers it' });
    for (let j = 0; j < i; j += 1) {
      const b = sources[j] as { source: string; path: (string | number)[] };
      if (b.source === '.') continue;
      if (a.source === b.source) issues.push({ path: a.path, message: `duplicates source "${b.source}"` });
      else if (a.source.startsWith(`${b.source}.`)) issues.push({ path: a.path, message: `is inside source "${b.source}"` });
      else if (b.source.startsWith(`${a.source}.`)) issues.push({ path: a.path, message: `contains source "${b.source}"` });
    }
  });
  return issues;
}

/** Rules 1 and 5: names that must not collide, compared case-insensitively because MySQL does. */
function uniqueNameIssues(names: { name: string; path: (string | number)[]; what: string }[]): Issue[] {
  const seen = new Map<string, string>();
  const issues: Issue[] = [];
  for (const n of names) {
    const lower = n.name.toLowerCase();
    const prior = seen.get(lower);
    if (prior !== undefined) issues.push({ path: n.path, message: `${n.what} "${n.name}" collides with ${prior}` });
    else seen.set(lower, n.what);
  }
  return issues;
}

const mappingSchema = z.strictObject({
  $schema: z.string().optional(), collection: z.string().min(1), table: identifierSchema,
  key: z.strictObject({                                     // UNIQUE column (or single-column PK) from _id
    column: identifierSchema, cast: z.enum(['objectId', 'string', 'bigint']).default('objectId'), sqlType: sqlType.optional(),
  }),
  runIdColumn: identifierSchema.nullable().default(null),   // load run id
  chunkColumn: identifierSchema.nullable().default(null),   // ledger id of the chunk (BIGINT UNSIGNED)
  extraColumn: identifierSchema.nullable().default(null),   // JSON of every field no column consumed
  onCastError: z.enum(['reject', 'null']).default('reject'),
  columns: z.array(column).default([]),
  children: z.array(child).default([]),
  inferred: z.looseObject({ at: z.string(), tool: z.string(), sampled: z.number().int(), review: z.array(z.string()) }).optional(),
}).superRefine((m, ctx) => {
  const issues: Issue[] = [];

  const parentNames: { name: string; path: (string | number)[]; what: string }[] = [{ name: m.key.column, path: ['key', 'column'], what: 'key column' }];
  m.columns.forEach((c, i) => parentNames.push({ name: c.column, path: ['columns', i, 'column'], what: `column ${i}` }));
  if (m.runIdColumn !== null) parentNames.push({ name: m.runIdColumn, path: ['runIdColumn'], what: 'runIdColumn' });
  if (m.chunkColumn !== null) parentNames.push({ name: m.chunkColumn, path: ['chunkColumn'], what: 'chunkColumn' });
  if (m.extraColumn !== null) parentNames.push({ name: m.extraColumn, path: ['extraColumn'], what: 'extraColumn' });
  issues.push(...uniqueNameIssues(parentNames));

  const parentSources: { source: string; path: (string | number)[] }[] = m.columns.map((c, i) => ({ source: c.source, path: ['columns', i, 'source'] }));
  m.children.forEach((ch, i) => parentSources.push({ source: ch.source, path: ['children', i, 'source'] }));
  issues.push(...sourceIssues(parentSources, false));

  m.columns.forEach((c, i) => {
    const d = defaultIssue(c, ['columns', i]);
    if (d) issues.push(d);
    issues.push(...optionIssues(c, ['columns', i]));
  });

  const tableNames: { name: string; path: (string | number)[]; what: string }[] = [{ name: m.table, path: ['table'], what: 'table' }];
  m.children.forEach((ch, i) => {
    tableNames.push({ name: ch.table, path: ['children', i, 'table'], what: `child table ${i}` });
    const names: { name: string; path: (string | number)[]; what: string }[] = [{ name: ch.parentColumn, path: ['children', i, 'parentColumn'], what: 'parentColumn' }];
    if (ch.indexColumn !== null) names.push({ name: ch.indexColumn, path: ['children', i, 'indexColumn'], what: 'indexColumn' });
    ch.columns.forEach((c, j) => names.push({ name: c.column, path: ['children', i, 'columns', j, 'column'], what: `column ${j}` }));
    issues.push(...uniqueNameIssues(names));
    issues.push(...sourceIssues(ch.columns.map((c, j) => ({ source: c.source, path: ['children', i, 'columns', j, 'source'] })), true));
    ch.columns.forEach((c, j) => {
      const d = defaultIssue(c, ['children', i, 'columns', j]);
      if (d) issues.push(d);
      issues.push(...optionIssues(c, ['children', i, 'columns', j]));
    });
  });
  issues.push(...uniqueNameIssues(tableNames));

  for (const issue of issues) ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
});

export default mappingSchema;
