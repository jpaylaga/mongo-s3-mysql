import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import buildMappingOrNull from '#infer/buildMapping';
import collectPathStats from '#infer/collectPathStats';
import identifier from '#infer/identifier';
import mappingSchema from '#mapping/mappingSchema';
import type { BuildMappingOptions, PathStats } from '#types';
import { fixtureDocs } from './seedChunks.js';

/** Stats for a field seen in every one of `count` documents with one type. */
const field = (
  path: string,
  type: string,
  count: number,
  patch: Partial<PathStats> = {}
): PathStats => ({
  path,
  present: count,
  nulls: 0,
  types: { [type]: count },
  maxChars: 5,
  maxBytes: 5,
  maxIntDigits: 1,
  maxScale: 0,
  arrayOfObjects: false,
  elements: null,
  ...patch,
});

const idStats = (count: number): PathStats => field('_id', 'objectId', count);

/** Every test here samples ids a key cast fits; the null case has its own test below. */
const buildMapping = (...args: Parameters<typeof buildMappingOrNull>) => {
  const built = buildMappingOrNull(...args);

  if (built === null) throw new Error('no key cast fits');

  return built;
};

const options = (patch: Partial<BuildMappingOptions> = {}): BuildMappingOptions => ({
  table: 'orders',
  keyColumn: 'mongo_id',
  runIdColumn: null,
  chunkColumn: null,
  extraColumn: null,
  timezone: 'UTC',
  childTables: false,
  sampled: 10,
  minPresence: 0.01,
  maxColumns: 200,
  toolVersion: 'mongo-s3-mysql@0.1.0',
  now: new Date('2026-10-13T03:10:00Z'),
  ...patch,
});

const names = (stats: PathStats[], patch: Partial<BuildMappingOptions> = {}) =>
  buildMapping('orders', stats, options(patch)).columns.map(c => c.column);

describe('buildMapping', () => {
  it('derives names per the documented table: snake case, empty fallback, leading digit', () => {
    const stats = [
      idStats(10),
      field('createdAt', 'date', 10),
      field('Device ID', 'string', 10),
      field('2fa', 'bool', 10),
      field('HTTPStatus', 'int', 10),
      field('__', 'int', 10),
      field('---', 'int', 10),
    ];

    // `__` trims to nothing and falls back to the field itself, which is a legal identifier; `---`
    // is not, so it gets a hashed name.
    expect(names(stats)).toEqual([
      'created_at',
      'device_id',
      '_2fa',
      'http_status',
      '__',
      `f_${createHash('sha1').update('---', 'utf8').digest('hex').slice(0, 6)}`,
    ]);

    const m = buildMapping('orders', stats, options());

    expect(m.columns.map(c => c.source)).toEqual([
      'createdAt',
      'Device ID',
      '2fa',
      'HTTPStatus',
      '__',
      '---',
    ]);

    expect(() => mappingSchema.parse(m)).not.toThrow();
  });

  it('uses the table it is given verbatim; infer derives its default with identifier()', () => {
    expect(identifier('audit-log')).toBe('audit_log');
    expect(identifier('audit.log')).toBe('audit_log');

    expect(
      buildMapping(
        'audit.log',
        [idStats(1)],
        options({ table: identifier('audit.log'), sampled: 1 })
      ).table
    ).toBe('audit_log');

    expect(
      buildMapping('audit.log', [idStats(1)], options({ table: 'entries', sampled: 1 })).table
    ).toBe('entries');

    expect(
      buildMapping('orders', [idStats(1)], options({ table: 'ArchivedOrders', sampled: 1 })).table
    ).toBe('ArchivedOrders');

    expect(
      buildMapping('orders', [idStats(1)], options({ table: 'userHistories', sampled: 1 })).table
    ).toBe('userHistories');
  });

  it('suffixes case-insensitive clashes with earlier and reserved names', () => {
    const stats = [
      idStats(10),
      field('created_at', 'date', 10),
      field('createdAt', 'date', 10),
      field('Created_At', 'date', 10),
      field('id', 'int', 10),
      field('mongo_id', 'string', 10),
      field('run', 'string', 10),
      field('RUN', 'string', 10),
    ];

    expect(names(stats, { runIdColumn: 'run', extraColumn: 'extra' })).toEqual([
      'created_at',
      'created_at_2',
      'created_at_3',
      'id_2',
      'mongo_id_2',
      'run_2',
      'run_3',
    ]);
  });

  it('shortens identifiers over 64 characters to 57 characters plus a sha1 tag', () => {
    const long = `f${'x'.repeat(70)}`;
    const other = `f${'x'.repeat(70)}y`;
    const [a, b] = names([idStats(10), field(long, 'int', 10), field(other, 'int', 10)]);

    expect(a).toHaveLength(64);

    expect(a).toBe(
      `${long.slice(0, 57)}_${createHash('sha1').update(long, 'utf8').digest('hex').slice(0, 6)}`
    );

    expect(b).toHaveLength(64);
    expect(b).not.toBe(a);

    const table = buildMapping(long, [idStats(1)], options({ table: long, sampled: 1 })).table;

    expect(table).toHaveLength(64);
  });

  it('casts the key by the majority _id type and reviews the minority', () => {
    const strings = buildMapping(
      'c',
      [field('_id', 'string', 10, { maxChars: 9, maxBytes: 9 })],
      options()
    );

    expect(strings.key).toEqual({ column: 'mongo_id', cast: 'string', sqlType: 'VARCHAR(32)' });
    expect(strings.inferred?.review).toEqual([]);

    const ints = buildMapping(
      'c',
      [{ ...field('_id', 'int', 10), types: { int: 6, long: 4 } }],
      options()
    );

    expect(ints.key).toEqual({ column: 'mongo_id', cast: 'bigint', sqlType: 'BIGINT' });

    const mixed = buildMapping(
      'c',
      [{ ...field('_id', 'objectId', 10), types: { objectId: 7, string: 3 } }],
      options()
    );

    expect(mixed.key.cast).toBe('objectId');

    expect(mixed.inferred?.review).toEqual([
      '_id: 3 non-ObjectId _id in the sample; such lines are rejected (key cast objectId)',
    ]);

    const missing = buildMapping(
      'c',
      [{ ...field('_id', 'objectId', 8), types: { objectId: 8 } }],
      options()
    );

    expect(missing.inferred?.review).toEqual([
      '_id: 2 non-ObjectId _id in the sample; such lines are rejected (key cast objectId)',
    ]);

    // No sampled _id fits a key cast (UUID binaries, doubles, nothing at all): no mapping, instead
    // of one that rejects every line.
    expect(buildMappingOrNull('c', [], options({ sampled: 0 }))).toBeNull();
    expect(buildMappingOrNull('c', [field('_id', 'binary', 10)], options())).toBeNull();
    expect(buildMappingOrNull('c', [field('_id', 'double', 10)], options())).toBeNull();

    // A string key is sized by its own ladder, capped at 760: a UNIQUE key cannot be TEXT and the
    // key ledger stops there.
    const longKey = buildMapping(
      'c',
      [field('_id', 'string', 10, { maxChars: 400, maxBytes: 400 })],
      options()
    );

    expect(longKey.key.sqlType).toBe('VARCHAR(760)');

    const tooLong = buildMapping(
      'c',
      [field('_id', 'string', 10, { maxChars: 900, maxBytes: 900 })],
      options()
    );

    expect(tooLong.key.sqlType).toBe('VARCHAR(760)');

    expect(tooLong.inferred?.review).toEqual([
      '_id: the longest sampled string _id has 900 characters; keys over 760 ' +
        'cannot be indexed or recorded in the key ledger',
    ]);
  });

  it('writes nullable columns with sqlType, note, datetime options and decimal round flag', () => {
    const stats = [
      idStats(10),
      field('when', 'date', 10),
      field('amount', 'decimal', 10, { maxIntDigits: 2, maxScale: 34 }),
    ];

    const m = buildMapping('c', stats, options({ timezone: 'Asia/Manila' }));

    expect(m.columns[0]).toEqual({
      column: 'when',
      source: 'when',
      cast: 'datetime',
      fsp: 3,
      timezone: 'Asia/Manila',
      sqlType: 'DATETIME(3)',
      note: 'date 10, wall clock in Asia/Manila',
    });

    expect(m.columns[1]).toEqual({
      column: 'amount',
      source: 'amount',
      cast: 'decimal',
      round: 'half-up',
      sqlType: 'DECIMAL(38,30)',
      note: 'decimal 10',
    });

    expect(m.inferred?.review).toEqual([
      'amount: scale clamped from 34 to 30; values are rounded half-up',
    ]);

    for (const c of m.columns) expect(c).not.toHaveProperty('default');

    expect(m.onCastError).toBe('reject');
  });

  it('leaves rare fields to the extra column, or drops them, with a review line', () => {
    const stats = [idStats(100), field('rare', 'string', 1), field('common', 'string', 100)];

    const extra = buildMapping(
      'c',
      stats,
      options({ sampled: 100, minPresence: 0.02, extraColumn: '_extra' })
    );

    expect(extra.columns.map(c => c.column)).toEqual(['common']);
    expect(extra.inferred?.review).toEqual(['rare: present in 1.0% of samples -> left in _extra']);

    const dropped = buildMapping('c', stats, options({ sampled: 100, minPresence: 0.02 }));

    expect(dropped.inferred?.review).toEqual(['rare: present in 1.0% of samples -> dropped']);
  });

  it('stops at maxColumns and refuses sources it cannot address', () => {
    const stats = [
      idStats(10),
      field('a', 'int', 10),
      field('b', 'int', 10),
      field('c', 'int', 10),
      field('$bad', 'int', 10),
      field('dot.ted', 'int', 10),
    ];

    const m = buildMapping('c', stats, options({ maxColumns: 2, extraColumn: '_extra' }));

    expect(m.columns.map(c => c.column)).toEqual(['a', 'b']);

    expect(m.inferred?.review).toEqual([
      'c: over maxColumns 2 -> left in _extra',
      '$bad: not addressable as a source path -> left in _extra',
      'dot.ted: not addressable as a source path -> left in _extra',
    ]);
  });

  it('builds child tables for arrays of objects only with --child-tables', () => {
    const elements = [field('sku', 'string', 20), field('qty', 'int', 20), field('rare', 'int', 1)];
    const items = field('items', 'array', 10, { arrayOfObjects: true, elements });
    const json = buildMapping('orders', [idStats(10), items], options());

    expect(json.children).toEqual([]);
    expect(json.columns[0]).toMatchObject({ column: 'items', cast: 'json', sqlType: 'JSON' });

    const m = buildMapping(
      'orders',
      [idStats(10), items],
      options({ childTables: true, minPresence: 0.1 })
    );

    expect(m.columns).toEqual([]);
    expect(m.children).toHaveLength(1);

    expect(m.children[0]).toMatchObject({
      table: 'orders_items',
      source: 'items',
      parentColumn: 'order_mongo_id',
      indexColumn: 'item_index',
    });

    expect(m.children[0]?.columns.map(c => c.column)).toEqual(['sku', 'qty']);
    // Element presence is measured against the element count, not the document count.
    expect(m.inferred?.review).toEqual(['items.rare: present in 5.0% of samples; dropped']);
    expect(() => mappingSchema.parse(m)).not.toThrow();
  });

  it('keeps an array as json when no element field qualifies, and reserves child names', () => {
    // Element presence is relative to the most frequent element field, so a lone field is always
    // 100% present; only an unaddressable source can leave a child table without columns.
    const none = field('items', 'array', 10, {
      arrayOfObjects: true,
      elements: [field('$x', 'int', 1)],
    });

    const m = buildMapping(
      'orders',
      [idStats(10), none],
      options({ childTables: true, minPresence: 0.5 })
    );

    expect(m.children).toEqual([]);
    expect(m.columns[0]).toMatchObject({ column: 'items', cast: 'json' });

    expect(m.inferred?.review).toEqual([
      'items.$x: not addressable as a source path; dropped',
      'items: no element field qualified for a child table; kept as json',
    ]);

    const clash = field('item', 'array', 10, {
      arrayOfObjects: true,
      elements: [
        field('id', 'int', 10),
        field('item_index', 'int', 10),
        field('order_mongo_id', 'int', 10),
      ],
    });

    const c = buildMapping('orders', [idStats(10), clash], options({ childTables: true }));

    expect(c.children[0]).toMatchObject({
      table: 'orders_item',
      parentColumn: 'order_mongo_id',
      indexColumn: 'item_index',
    });

    expect(c.children[0]?.columns.map(x => x.column)).toEqual([
      'id_2',
      'item_index_2',
      'order_mongo_id_2',
    ]);

    expect(() => mappingSchema.parse(c)).not.toThrow();
  });

  it('records the run in inferred and keeps top-level fields in first-seen order', () => {
    const stats = [idStats(3), field('z', 'int', 3), field('a', 'int', 3)];

    const m = buildMapping(
      'c',
      stats,
      options({ sampled: 3, runIdColumn: 'run', chunkColumn: 'chunk', extraColumn: 'extra' })
    );

    expect(m.columns.map(c => c.column)).toEqual(['z', 'a']);
    expect(m).toMatchObject({ runIdColumn: 'run', chunkColumn: 'chunk', extraColumn: 'extra' });

    expect(m.inferred).toEqual({
      at: '2026-10-13T03:10:00Z',
      tool: 'mongo-s3-mysql@0.1.0',
      sampled: 3,
      review: [],
    });
  });

  it('reproduces the orders golden mapping (examples/orders.mapping.json)', async () => {
    const stats = collectPathStats(await fixtureDocs('orders'));

    const m = buildMapping(
      'orders',
      stats,
      options({
        sampled: 60,
        minPresence: 0.02,
        runIdColumn: 'import_run',
        chunkColumn: '_msm_chunk',
        extraColumn: '_extra',
        childTables: true,
      })
    );

    expect(m).toMatchObject({
      collection: 'orders',
      table: 'orders',
      key: { column: 'mongo_id', cast: 'objectId', sqlType: 'CHAR(24)' },
      runIdColumn: 'import_run',
      chunkColumn: '_msm_chunk',
      extraColumn: '_extra',
      onCastError: 'reject',
    });

    expect(m.columns.map(({ note: _n, ...c }) => c)).toEqual([
      { column: 'status', source: 'status', cast: 'string', sqlType: 'VARCHAR(32)' },
      { column: 'total', source: 'total', cast: 'decimal', sqlType: 'DECIMAL(14,2)' },
      { column: 'sequence', source: 'sequence', cast: 'bigint', sqlType: 'BIGINT' },
      { column: 'paid', source: 'paid', cast: 'bool', sqlType: 'TINYINT(1)' },
      {
        column: 'created_at',
        source: 'createdAt',
        cast: 'datetime',
        fsp: 3,
        timezone: 'UTC',
        sqlType: 'DATETIME(3)',
      },
      { column: 'customer', source: 'customer', cast: 'json', sqlType: 'JSON' },
      { column: 'tags', source: 'tags', cast: 'json', sqlType: 'JSON' },
    ]);

    expect(m.columns[1]?.note).toBe('decimal 58, int 2');
    expect(m.children).toHaveLength(1);

    expect(m.children[0]).toMatchObject({
      table: 'orders_items',
      source: 'items',
      parentColumn: 'order_mongo_id',
      indexColumn: 'item_index',
    });

    expect(m.children[0]?.columns.map(({ note: _n, ...c }) => c)).toEqual([
      { column: 'sku', source: 'sku', cast: 'string', sqlType: 'VARCHAR(32)' },
      { column: 'qty', source: 'qty', cast: 'int', sqlType: 'INT' },
      { column: 'price', source: 'price', cast: 'decimal', sqlType: 'DECIMAL(10,2)' },
    ]);

    expect(m.inferred).toEqual({
      at: '2026-10-13T03:10:00Z',
      tool: 'mongo-s3-mysql@0.1.0',
      sampled: 60,
      review: [
        'note: present in 1.7% of samples -> left in _extra',
        '_id: 1 non-ObjectId _id in the sample; such lines are rejected (key cast objectId)',
      ],
    });

    expect(mappingSchema.parse(m)).toEqual(m);
  });

  it('turns the widest VARCHARs into TEXT until the row fits, with a review line each', () => {
    // 40 string fields of 300 characters each get VARCHAR(512): 40 x (4 x 512 + 2) is far over the
    // limit.
    const stats = [
      idStats(20),
      ...Array.from({ length: 40 }, (_, i) =>
        field(`f${String(i).padStart(2, '0')}`, 'string', 20, { maxChars: 300, maxBytes: 300 })
      ),
    ];

    const m = buildMapping(
      'wide',
      stats,
      options({
        table: 'wide',
        sampled: 20,
        runIdColumn: 'run',
        chunkColumn: 'chunk',
        extraColumn: 'extra',
      })
    );

    const text = m.columns.filter(c => c.sqlType === 'TEXT').map(c => c.column);
    const varchar = m.columns.filter(c => c.sqlType === 'VARCHAR(512)');

    expect(text.length).toBeGreaterThan(0);
    expect(text.length + varchar.length).toBe(40);
    // The estimate: 8 (id) + 96 (CHAR(24) key) + 258 + 8 + 12 (provenance) + the columns.
    expect(8 + 96 + 278 + varchar.length * 2050 + text.length * 12).toBeLessThanOrEqual(65_000);

    expect(8 + 96 + 278 + (varchar.length + 1) * 2050 + (text.length - 1) * 12).toBeGreaterThan(
      65_000
    );

    // The last columns go first on a tie, so the leading fields keep their VARCHAR.
    expect(text).toEqual(m.columns.slice(40 - text.length).map(c => c.column));

    for (const col of text)
      expect(m.inferred?.review).toContain(
        `${col}: VARCHAR(512) -> TEXT to stay under MySQL's 65,535-byte row limit`
      );

    expect(mappingSchema.parse(m)).toEqual(m);

    // 60 VARCHAR(255) columns (about 61 KB) fit as they are, and so does the orders golden.
    const fits = buildMapping(
      'ok',
      [
        idStats(20),
        ...Array.from({ length: 60 }, (_, i) =>
          field(`g${i}`, 'string', 20, { maxChars: 150, maxBytes: 150 })
        ),
      ],
      options({ table: 'ok', sampled: 20 })
    );

    expect(fits.columns.every(c => c.sqlType === 'VARCHAR(255)')).toBe(true);
    expect(fits.inferred?.review).toEqual([]);
  });

  it('applies the row limit to each child table on its own', () => {
    const elements = Array.from({ length: 40 }, (_, i) =>
      field(`e${String(i).padStart(2, '0')}`, 'string', 10, { maxChars: 400, maxBytes: 400 })
    );

    const stats = [idStats(10), field('items', 'array', 10, { arrayOfObjects: true, elements })];
    const m = buildMapping('orders', stats, options({ childTables: true }));
    const child = m.children[0];

    expect(child?.columns.filter(c => c.sqlType === 'TEXT').length).toBeGreaterThan(0);

    expect(m.inferred?.review).toContainEqual(
      expect.stringMatching(
        /^items\.e39: VARCHAR\(1024\) -> TEXT to stay under MySQL's 65,535-byte row limit$/
      )
    );
  });

  it('never maps _id as a column: the key covers it', () => {
    expect(names([idStats(10)])).toEqual([]);
  });

  it("maps an element _id inside a child table: it is the element's own field, not the key", () => {
    const elements = [field('_id', 'objectId', 20), field('sku', 'string', 20)];
    const items = field('items', 'array', 10, { arrayOfObjects: true, elements });
    const m = buildMapping('orders', [idStats(10), items], options({ childTables: true }));

    expect(m.children[0]?.columns.map(c => [c.column, c.source, c.cast])).toEqual([
      ['id_2', '_id', 'objectId'],
      ['sku', 'sku', 'string'],
    ]);

    expect(() => mappingSchema.parse(m)).not.toThrow();
  });
});
