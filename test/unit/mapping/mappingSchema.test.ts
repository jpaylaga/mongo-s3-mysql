import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import mappingSchema from '#mapping/mappingSchema';
import { ordersMapping, twinMapping } from '../mysql/fakeTables.js';

const base = () => ({
  collection: 'audit_log',
  table: 'audit_log_entries',
  key: { column: 'source_mongo_id' },
  columns: [{ column: 'actor_id', source: 'actor_id', cast: 'string' }],
});

const messages = (input: unknown): string[] => {
  const r = mappingSchema.safeParse(input);

  return r.success ? [] : r.error.issues.map(i => `${i.path.join('.')}: ${i.message}`);
};

describe('mappingSchema', () => {
  it('parses the documented examples and applies defaults', () => {
    const twin = twinMapping();

    expect(twin.key.cast).toBe('objectId');
    expect(twin.chunkColumn).toBeNull();
    expect(twin.extraColumn).toBeNull();
    expect(twin.children).toEqual([]);
    expect(twin.onCastError).toBe('reject');
    expect(ordersMapping().children[0]?.indexColumn).toBe('item_index');

    const minimal = mappingSchema.parse({ collection: 'c', table: 't', key: { column: 'k' } });

    expect(minimal.columns).toEqual([]);
    expect(minimal.runIdColumn).toBeNull();
  });

  it('is strict about keys and identifiers', () => {
    expect(messages({ ...base(), extra: 1 })).toEqual([
      expect.stringContaining('Unrecognized key'),
    ]);

    expect(messages({ ...base(), table: '1bad' })[0]).toMatch(/table: letters, digits, underscore/);

    expect(
      messages({ ...base(), columns: [{ column: 'a', source: 'a.', cast: 'string' }] })[0]
    ).toMatch(/empty path segment/);

    expect(
      messages({ ...base(), columns: [{ column: 'a', source: '$a', cast: 'string' }] })[0]
    ).toMatch(/columns.0.source/);

    expect(
      messages({
        ...base(),
        columns: [{ column: 'a', source: 'a', cast: 'datetime', timezone: 'Mars/Olympus' }],
      })[0]
    ).toMatch(/IANA time zone/);

    expect(
      messages({
        ...base(),
        columns: [{ column: 'a', source: 'a', cast: 'string', sqlType: 'VARCHAR(10) COLLATE x' }],
      })[0]
    ).toMatch(/like VARCHAR\(255\)/);
  });

  it('rule 1: column names unique case-insensitively across key, columns and provenance', () => {
    const m = messages({
      ...base(),
      runIdColumn: 'Actor_ID',
      chunkColumn: 'source_mongo_id',
      extraColumn: 'extra',
      columns: [
        { column: 'actor_id', source: 'a', cast: 'string' },
        { column: 'EXTRA', source: 'b', cast: 'string' },
      ],
    });

    expect(m).toContainEqual(
      expect.stringMatching(/runIdColumn: runIdColumn "Actor_ID" collides with column 0/)
    );

    expect(m).toContainEqual(expect.stringMatching(/chunkColumn: .*collides with key column/));

    expect(m).toContainEqual(
      expect.stringMatching(/extraColumn: extraColumn "extra" collides with column 1/)
    );
  });

  it('rule 2: sources may not repeat, nest, start with _id or be "." outside children', () => {
    const m = messages({
      ...base(),
      columns: [
        { column: 'a', source: 'data', cast: 'json' },
        { column: 'b', source: 'data.page', cast: 'int' },
        { column: 'c', source: 'data', cast: 'string' },
        { column: 'd', source: '_id.x', cast: 'string' },
        { column: 'e', source: '.', cast: 'json' },
        { column: 'f', source: 'items.sku', cast: 'string' },
      ],
      children: [
        {
          table: 'items',
          source: 'items',
          parentColumn: 'p',
          columns: [{ column: 'x', source: '.', cast: 'string' }],
        },
      ],
    });

    expect(m).toContainEqual(expect.stringMatching(/columns.1.source: is inside source "data"/));
    expect(m).toContainEqual(expect.stringMatching(/columns.2.source: duplicates source "data"/));
    expect(m).toContainEqual(expect.stringMatching(/columns.3.source: must not start with _id/));

    expect(m).toContainEqual(
      expect.stringMatching(/columns.4.source: "\." is only valid inside children/)
    );

    expect(m).toContainEqual(
      expect.stringMatching(/children.0.source: contains source "items.sku"/)
    );

    expect(m.some(x => x.startsWith('children.0.columns.0.source'))).toBe(false);
  });

  it('rule 2 bans _id on parent sources only: an element _id in a child is its own field', () => {
    const m = messages({
      ...base(),
      children: [
        {
          table: 'items',
          source: 'items',
          parentColumn: 'p',
          columns: [
            { column: 'item_mongo_id', source: '_id', cast: 'objectId' },
            { column: 'sku', source: 'sku', cast: 'string' },
          ],
        },
      ],
    });

    expect(m).toEqual([]);
  });

  it('rule 3: default types follow the cast', () => {
    const def = (cast: string, value: unknown) =>
      messages({ ...base(), columns: [{ column: 'a', source: 'a', cast, default: value }] });

    expect(def('string', '')).toEqual([]);
    expect(def('string', 1)[0]).toMatch(/default: must be a string/);
    expect(def('decimal', '0.00')).toEqual([]);
    expect(def('decimal', 'abc')[0]).toMatch(/decimal literal/);
    expect(def('decimal', 1)[0]).toMatch(/decimal literal/);
    expect(def('int', 1)).toEqual([]);
    expect(def('int', 1.5)[0]).toMatch(/must be an integer for cast int/);
    expect(def('bigint', '1')[0]).toMatch(/must be an integer for cast bigint/);
    expect(def('double', 1.5)).toEqual([]);
    expect(def('double', '1.5')[0]).toMatch(/must be a number/);
    expect(def('bool', false)).toEqual([]);
    expect(def('bool', 0)[0]).toMatch(/must be a boolean/);

    for (const cast of ['datetime', 'objectId', 'json'])
      expect(def(cast, 'x')[0]).toMatch(new RegExp(`not allowed for cast ${cast}`));
  });

  it('rule 4: fsp and timezone only on datetime, round only on decimal', () => {
    const m = messages({
      ...base(),
      columns: [
        { column: 'a', source: 'a', cast: 'string', fsp: 3, timezone: 'UTC', round: 'half-up' },
        { column: 'b', source: 'b', cast: 'datetime', fsp: 6, timezone: 'Asia/Manila' },
        { column: 'c', source: 'c', cast: 'decimal', round: 'reject' },
      ],
    });

    expect(m).toEqual([
      expect.stringMatching(/columns.0.fsp: only for cast datetime/),
      expect.stringMatching(/columns.0.timezone: only for cast datetime/),
      expect.stringMatching(/columns.0.round: only for cast decimal/),
    ]);
  });

  it('rule 5: child tables unique, not the table; child columns unique with parent, index', () => {
    const m = messages({
      ...base(),
      children: [
        {
          table: 'audit_log_entries',
          source: 'x',
          parentColumn: 'p',
          indexColumn: 'P',
          columns: [{ column: 'p', source: 'a', cast: 'string' }],
        },
        {
          table: 'Items',
          source: 'y',
          parentColumn: 'p',
          columns: [
            { column: 'a', source: 'a', cast: 'string' },
            { column: 'A', source: 'b', cast: 'string' },
          ],
        },
        {
          table: 'items',
          source: 'z',
          parentColumn: 'p',
          columns: [{ column: 'a', source: 'a', cast: 'string' }],
        },
      ],
    });

    expect(m).toContainEqual(
      expect.stringMatching(
        /children.0.table: child table 0 "audit_log_entries" collides with table/
      )
    );

    expect(m).toContainEqual(
      expect.stringMatching(/children.0.indexColumn: indexColumn "P" collides with parentColumn/)
    );

    expect(m).toContainEqual(
      expect.stringMatching(/children.0.columns.0.column: column 0 "p" collides with parentColumn/)
    );

    expect(m).toContainEqual(
      expect.stringMatching(/children.1.columns.1.column: column 1 "A" collides with column 0/)
    );

    expect(m).toContainEqual(
      expect.stringMatching(/children.2.table: child table 2 "items" collides with child table 1/)
    );
  });

  it('reports every problem together in a readable form', () => {
    const r = mappingSchema.safeParse({
      ...base(),
      runIdColumn: 'actor_id',
      columns: [{ column: 'actor_id', source: '_id', cast: 'int', default: 'x' }],
    });

    expect(r.success).toBe(false);

    const text = r.success ? '' : z.prettifyError(r.error);

    expect(text).toMatch(/collides/);
    expect(text).toMatch(/_id/);
    expect(text).toMatch(/integer/);
  });
});
