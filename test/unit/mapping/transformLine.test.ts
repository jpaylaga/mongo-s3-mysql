import { describe, expect, it } from 'vitest';
import mappingSchema from '../../../src/mapping/mappingSchema.js';
import transformLine from '../../../src/mapping/transformLine.js';
import valueColumns from '../../../src/mapping/valueColumns.js';
import type { Mapping, TableInfo, TransformContext, TransformResult } from '../../../src/types.js';
import { readFixture } from '../../helpers.js';
import { ordersMapping, ordersTables, twinMapping, twinTable } from '../mysql/fakeTables.js';

const ctxFor = (mapping: Mapping, table: TableInfo, children: Map<string, TableInfo> = new Map()): TransformContext =>
  ({ mapping, table, children, loadRunId: 'load-20261013T040000Z', ledgerId: 17 });

const row = (r: TransformResult) => {
  if (r.kind !== 'row') throw new Error(`rejected: ${r.reason}`);
  return r;
};
const rejected = (r: TransformResult) => {
  if (r.kind !== 'reject') throw new Error(`expected a reject, got row ${r.key}`);
  return r;
};

describe('transformLine', () => {
  it('turns the twin fixture into a row: key, mapped columns, run id', async () => {
    const lines = (await readFixture('audit_log.sample.jsonl')).split('\n').filter(Boolean);
    const r = row(transformLine(lines[0] as string, 1, ctxFor(twinMapping(), twinTable())));
    expect(r.key).toBe('69a4d3015a5a5a0001000001');
    expect(r.values).toEqual([
      '69a4d3015a5a5a0001000001', 'tenant-a_1010', 'User A-01 visited https://app.example.com/orders/100',
      '{"request_input":{"page":{"$numberInt":"1"},"q":"status:open"},"response":{"ok":true}}', '10.0.4.17', null,
      '2026-03-02 08:00:01', '2026-03-02 08:00:02', 'load-20261013T040000Z',
    ]);
    expect(r.castErrors).toBe(0);
    expect(r.children.size).toBe(0);
  });

  it('fills the row in valueColumns order, so the INSERT column list and the VALUES can never drift apart', () => {
    const mapping = ordersMapping();
    const tables = ordersTables();
    const line = JSON.stringify({ _id: { $oid: '69a4d3015a5a5a0001000009' }, status: 'open', total: { $numberDecimal: '1.50' }, extra_field: 'kept', items: [] });
    const r = row(transformLine(line, 9, ctxFor(mapping, tables.get('orders') as TableInfo, tables)));
    const columns = valueColumns(mapping);
    expect(r.values).toHaveLength(columns.length);
    const at = (column: string) => r.values[columns.indexOf(column)];
    expect(at('mongo_id')).toBe('69a4d3015a5a5a0001000009');
    expect(at('status')).toBe('open');
    expect(at('total')).toBe('1.5');
    expect(at('import_run')).toBe('load-20261013T040000Z');
    expect(at('_msm_chunk')).toBe(17);
    expect(at('_extra')).toBe('{"extra_field":"kept"}');
  });

  it('applies defaults for missing or null fields and NULL otherwise', () => {
    const line = JSON.stringify({ _id: { $oid: '69a4d3015a5a5a0001000002' }, actor_id: null, data: null });
    const r = row(transformLine(line, 2, ctxFor(twinMapping(), twinTable())));
    expect(r.values.slice(1)).toEqual(['', '', null, null, null, null, null, 'load-20261013T040000Z']);
  });

  it('rejects lines without a usable _id whatever onCastError says', () => {
    const mapping = { ...twinMapping(), onCastError: 'null' as const };
    const ctx = ctxFor(mapping, twinTable());
    expect(rejected(transformLine('{"actor_id":"x"}', 3, ctx))).toMatchObject({ lineNo: 3, reason: '_id: not an ObjectId: missing', text: '{"actor_id":"x"}' });
    expect(rejected(transformLine('{"_id":"legacy-7"}', 4, ctx)).reason).toMatch(/^_id: not an ObjectId: a string/);
    expect(rejected(transformLine('{"_id":{"$numberInt":"7"}}', 5, ctx)).reason).toMatch(/^_id: not an ObjectId/);
    expect(rejected(transformLine('not json', 6, ctx)).reason).toMatch(/^invalid JSON: /);
    expect(rejected(transformLine('[1,2]', 7, ctx)).reason).toBe('not a JSON object');
    expect(rejected(transformLine('"s"', 8, ctx)).reason).toBe('not a JSON object');
  });

  it('honours the key cast: string and bigint keys', () => {
    const stringKey = mappingSchema.parse({ collection: 'c', table: 't', key: { column: 'k', cast: 'string' } });
    const bigKey = mappingSchema.parse({ collection: 'c', table: 't', key: { column: 'k', cast: 'bigint' } });
    const table: TableInfo = { name: 't', columns: new Map(), uniqueKeys: [], primaryKey: [], primaryKeyPrefix: false, indexedColumns: [] };
    expect(row(transformLine('{"_id":"legacy-7"}', 1, ctxFor(stringKey, table))).values).toEqual(['legacy-7']);
    expect(row(transformLine('{"_id":{"$numberLong":"42"}}', 1, ctxFor(bigKey, table))).values).toEqual(['42']);
    expect(rejected(transformLine('{"_id":{"$oid":"69a4d3015a5a5a0001000002"}}', 1, ctxFor(bigKey, table))).reason).toMatch(/^_id: not an integer/);
  });

  it('rejects on a cast error by default and nulls the column under onCastError: null', () => {
    const line = JSON.stringify({ _id: { $oid: '69a4d3015a5a5a0001000003' }, actor_id: 5, ip_address: 'x'.repeat(46) });
    const r = rejected(transformLine(line, 9, ctxFor(twinMapping(), twinTable())));
    expect(r.reason).toBe('actor_id: not a string: a number');
    const lenient = ctxFor({ ...twinMapping(), onCastError: 'null' }, twinTable());
    const nullable = JSON.stringify({ _id: { $oid: '69a4d3015a5a5a0001000003' }, ip_address: 'x'.repeat(46), created_at: 'not a date' });
    const r2 = row(transformLine(nullable, 9, lenient));
    expect(r2.values[4]).toBeNull();
    expect(r2.values[6]).toBeNull();
    expect(r2.castErrors).toBe(2);
  });

  it('a null the live column cannot hold rejects the line whatever onCastError says', () => {
    // actor_id and description are NOT NULL in the twin; without their mapping defaults a missing field or a nulled cast error must not reach MySQL.
    const noDefaults: Mapping = { ...twinMapping(), columns: twinMapping().columns.map(({ default: _d, ...c }) => c) };
    const missing = JSON.stringify({ _id: { $oid: '69a4d3015a5a5a0001000003' }, description: 'd' });
    expect(rejected(transformLine(missing, 1, ctxFor(noDefaults, twinTable()))).reason).toBe('actor_id: null for NOT NULL column');
    const explicitNull = JSON.stringify({ _id: { $oid: '69a4d3015a5a5a0001000003' }, actor_id: 'a', description: null });
    expect(rejected(transformLine(explicitNull, 2, ctxFor(noDefaults, twinTable()))).reason).toBe('description: null for NOT NULL column');
    const uncastable = JSON.stringify({ _id: { $oid: '69a4d3015a5a5a0001000003' }, actor_id: 5, description: 'd' });
    expect(rejected(transformLine(uncastable, 3, ctxFor({ ...noDefaults, onCastError: 'null' }, twinTable()))).reason).toBe('actor_id: null for NOT NULL column');
    // With the defaults the same lines are rows, as before.
    expect(row(transformLine(missing, 1, ctxFor(twinMapping(), twinTable()))).values[1]).toBe('');
  });

  it('a child source that is present but not an array is a cast error: rejected, or counted and kept in the extra column', async () => {
    const tables = ordersTables();
    const ctx = ctxFor(ordersMapping(), tables.get('orders') as TableInfo, new Map([['orders_items', tables.get('orders_items') as TableInfo]]));
    const drifted = JSON.stringify({ _id: { $oid: '69a38f905a5a5a0001000009' }, status: 'open', items: { sku: 'SKU-1' } });
    expect(rejected(transformLine(drifted, 1, ctx)).reason).toBe('items: not an array: an object');
    const lenient = ctxFor({ ...ordersMapping(), onCastError: 'null' }, tables.get('orders') as TableInfo, new Map([['orders_items', tables.get('orders_items') as TableInfo]]));
    const r = row(transformLine(drifted, 1, lenient));
    expect(r.children.get('orders_items')).toEqual([]);
    expect(r.castErrors).toBe(1);
    expect(r.values[10]).toBe('{"items":{"sku":"SKU-1"}}');
  });

  it('json into a text column and the extra column are bound by the live column length', () => {
    const base = twinTable();
    const columns = new Map(base.columns);
    columns.set('data', { ...columns.get('data')!, dataType: 'text', octetLength: 64 });
    columns.set('extra', { name: 'extra', dataType: 'varchar', nullable: true, hasDefault: false, autoIncrement: false, collation: 'utf8mb4_0900_ai_ci', charLength: 20, octetLength: 80, precision: null, scale: null, fsp: null, members: null });
    const table: TableInfo = { ...base, columns };
    const big = JSON.stringify({ _id: { $oid: '69a4d3015a5a5a0001000003' }, data: { text: 'x'.repeat(100) } });
    expect(rejected(transformLine(big, 1, ctxFor(twinMapping(), table))).reason).toMatch(/^data: \d+ bytes exceed text \(64 bytes\)/);
    const withExtra = { ...twinMapping(), extraColumn: 'extra' };
    const spill = JSON.stringify({ _id: { $oid: '69a4d3015a5a5a0001000003' }, unmapped: 'y'.repeat(30) });
    expect(rejected(transformLine(spill, 2, ctxFor(withExtra, table))).reason).toMatch(/^extra: \d+ characters exceed varchar\(20\)/);
    expect(row(transformLine(JSON.stringify({ _id: { $oid: '69a4d3015a5a5a0001000003' }, unmapped: 'y' }), 3, ctxFor(withExtra, table))).values.at(-1)).toBe('{"unmapped":"y"}');
  });

  it('a value too deep for V8 rejects the line instead of failing the chunk', () => {
    const deep = `{"_id":{"$oid":"69a4d3015a5a5a0001000003"},"data":${'['.repeat(100_000)}${']'.repeat(100_000)}}`;
    const r = transformLine(deep, 1, ctxFor(twinMapping(), twinTable()));
    expect(r.kind).toBe('reject');
    if (r.kind === 'reject') expect(r.reason).toMatch(/^(data: value too large or too deep|value too large or too deep|invalid JSON)/);
  });

  it('uses the live column limits', () => {
    const line = JSON.stringify({ _id: { $oid: '69a4d3015a5a5a0001000003' }, ip_address: 'x'.repeat(46) });
    expect(rejected(transformLine(line, 1, ctxFor(twinMapping(), twinTable()))).reason).toMatch(/^ip_address: 46 characters exceed varchar\(45\)/);
    const tooEarly = JSON.stringify({ _id: { $oid: '69a4d3015a5a5a0001000003' }, created_at: { $date: { $numberLong: '0' } } });
    expect(rejected(transformLine(tooEarly, 1, ctxFor(twinMapping(), twinTable()))).reason).toMatch(/^created_at: .*TIMESTAMP range/);
  });

  it('builds child rows, the extra column and provenance columns for the orders mapping', async () => {
    const lines = (await readFixture('orders.sample.jsonl')).split('\n').filter(Boolean);
    const tables = ordersTables();
    const ctx = ctxFor(ordersMapping(), tables.get('orders') as TableInfo, new Map([['orders_items', tables.get('orders_items') as TableInfo]]));
    const r = row(transformLine(lines[1] as string, 2, ctx));
    expect(r.values).toEqual([
      '69a38f905a5a5a0001000002', 'open', '47.5', '1000001', 0, '2026-03-01 01:00:00.123',
      '{"id":{"$numberInt":"501"},"name":"Customer B","tier":"gold"}', '["priority"]',
      'load-20261013T040000Z', 17, null,
    ]);
    expect(r.children.get('orders_items')).toEqual([
      ['69a38f905a5a5a0001000002', 0, 'SKU-0101', 2, '8'],
      ['69a38f905a5a5a0001000002', 1, 'SKU-0102', 3, '9'],
    ]);
    // An empty array writes no child rows; a document with unmapped fields fills the extra column.
    const empty = row(transformLine(lines[2] as string, 3, ctx));
    expect(empty.children.get('orders_items')).toEqual([]);
    const withExtra = JSON.stringify({ _id: { $oid: '69a38f905a5a5a0001000009' }, status: 'open', note: 'gift wrap', meta: { a: 1 }, items: null });
    const e = row(transformLine(withExtra, 4, ctx));
    expect(e.values[10]).toBe('{"note":"gift wrap","meta":{"a":1}}');
    expect(e.children.get('orders_items')).toEqual([]);
  });

  it('feeds scalar child elements to "." columns only and omits the index without indexColumn', () => {
    const mapping = mappingSchema.parse({
      collection: 'c', table: 't', key: { column: 'k' },
      children: [{ table: 't_tags', source: 'tags', parentColumn: 'parent', columns: [
        { column: 'tag', source: '.', cast: 'string' }, { column: 'weight', source: 'weight', cast: 'int', default: 1 },
      ] }],
    });
    const table: TableInfo = { name: 't', columns: new Map(), uniqueKeys: [], primaryKey: [], primaryKeyPrefix: false, indexedColumns: [] };
    const line = JSON.stringify({ _id: { $oid: '69a38f905a5a5a0001000002' }, tags: ['gift', 'wrap'] });
    const r = row(transformLine(line, 1, ctxFor(mapping, table)));
    expect(r.children.get('t_tags')).toEqual([['69a38f905a5a5a0001000002', 'gift', 1], ['69a38f905a5a5a0001000002', 'wrap', 1]]);
    // An object element reaches the "." column whole, so a string cast refuses it; its fields feed the other columns.
    const mixed = JSON.stringify({ _id: { $oid: '69a38f905a5a5a0001000002' }, tags: ['gift', { weight: 3 }] });
    expect(rejected(transformLine(mixed, 2, ctxFor(mapping, table))).reason).toBe('t_tags.tag[1]: not a string: an object');
    const lenient = ctxFor({ ...mapping, onCastError: 'null' }, table);
    const r2 = row(transformLine(mixed, 2, lenient));
    expect(r2.children.get('t_tags')).toEqual([['69a38f905a5a5a0001000002', 'gift', 1], ['69a38f905a5a5a0001000002', null, 3]]);
    expect(r2.castErrors).toBe(1);
    const bad = JSON.stringify({ _id: { $oid: '69a38f905a5a5a0001000002' }, tags: [{ weight: 'heavy' }] });
    expect(rejected(transformLine(bad, 3, ctxFor(mapping, table))).reason).toBe('t_tags.tag[0]: not a string: an object');
    const weightOnly = { ...mapping, children: [{ ...mapping.children[0]!, columns: [mapping.children[0]!.columns[1]!] }] };
    expect(rejected(transformLine(bad, 4, ctxFor(weightOnly, table))).reason).toBe('t_tags.weight[0]: not an integer: a string');
  });

  it('clips reject text to 16,384 bytes at a character boundary and reasons to 512 characters', () => {
    const ctx = ctxFor(twinMapping(), twinTable());
    const long = `{"actor_id":"${'é'.repeat(9000)}"}`;
    const r = rejected(transformLine(long, 1, ctx));
    expect(Buffer.byteLength(r.text, 'utf8')).toBeLessThanOrEqual(16_384);
    expect(r.text.endsWith('é')).toBe(true);
    expect(r.text).toBe(long.slice(0, r.text.length));
    expect(rejected(transformLine(`{"actor_id":"x"${',"a":1'.repeat(3000)}`, 1, ctx)).reason.length).toBeLessThanOrEqual(512);
  });
});
