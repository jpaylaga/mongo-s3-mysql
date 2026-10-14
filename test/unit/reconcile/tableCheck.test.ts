import { describe, expect, it } from 'vitest';
import tableCheck from '../../../src/reconcile/tableCheck.js';
import { ordersMapping, ordersTables, twinMapping, twinTable } from '../mysql/fakeTables.js';
import { fakePool, type Rule } from '../mysql/fakeMysql.js';
import { ledgerRow, noSuchTable } from './fixtures.js';
import type { TableInfo } from '../../../src/types.js';

const counts = (keyed: number, untracked: number): Rule => [/^SELECT COUNT\(`\w+`\) AS keyed/, [{ keyed: String(keyed), untracked: String(untracked) }]];
/** Every selected chunk recorded as many keys as it inserted (`counts` overrides per id) unless `without` names it. */
const keyRows = (without: number[] = [], counts: Record<number, number> = {}): Rule => [/COUNT\(\*\) AS key_rows FROM `_msm_load_keys`/, (params) => (params[0] as number[]).filter((id) => !without.includes(id)).map((id) => ({ chunk_id: String(id), key_rows: String(counts[id] ?? 1_000_000) }))];
const expected = (n: number): Rule => [/COUNT\(DISTINCT `key_value`\) AS expected/, [{ expected: String(n) }]];
const missing = (n: number): Rule => [/COUNT\(DISTINCT k\.`key_value`\) AS missing/, [{ missing: String(n) }]];
const orders = ordersTables().get('orders') as TableInfo;

describe('tableCheck', () => {
  it('passes when every key of the selected chunks has a row; foreign is what the selection does not account for', async () => {
    const { pool, sqls } = fakePool([counts(1_050, 7), keyRows(), expected(1_000), missing(0)]);
    const r = await tableCheck(pool, twinMapping(), twinTable(), [ledgerRow({ id: 1, rows_inserted: 100 }), ledgerRow({ id: 2, rows_inserted: 900 })], true);
    expect(r).toEqual({ drifts: [], keyed: 1_050, untracked: 7, foreign: 50, expected: 1_000, actual: 1_000, unproven: [] });
    expect(sqls()[0]).toBe('SELECT COUNT(`source_mongo_id`) AS keyed, COUNT(*) - COUNT(`source_mongo_id`) AS untracked FROM `audit_log_entries`');
    expect(sqls()[1]).toBe('SELECT `chunk_id`, COUNT(*) AS key_rows FROM `_msm_load_keys` WHERE `chunk_id` IN (?) GROUP BY `chunk_id`');
    // The anti-join converts the ledger text to the key column's collation so the UNIQUE index on the key is used.
    expect(sqls()[3]).toContain('LEFT JOIN `audit_log_entries` ON `audit_log_entries`.`source_mongo_id` = CONVERT(k.`key_value` USING utf8mb4) COLLATE utf8mb4_0900_ai_ci WHERE k.`chunk_id` IN (?) AND `audit_log_entries`.`source_mongo_id` IS NULL');
    expect(sqls()).toHaveLength(4);
  });

  it('a chunk that wrote rows but has no key rows is unproven: left out of the proofs, named in the result', async () => {
    const rows = [ledgerRow({ id: 1, rows_inserted: 100 }), ledgerRow({ id: 2, chunk_run_id: 'x-audit_log-full-collection-rest', rows_inserted: 900 }), ledgerRow({ id: 3, chunk_run_id: 'x-audit_log-manifest-only-full', rows_inserted: 0, exported_count: 0, lines_done: 0 })];
    const { pool, calls } = fakePool([counts(1_000, 0), keyRows([2, 3]), expected(100), missing(0)]);
    const r = await tableCheck(pool, twinMapping(), twinTable(), rows, true);
    expect(r).toMatchObject({ drifts: [], expected: 100, actual: 100, foreign: 900, unproven: ['x-audit_log-full-collection-rest'] });
    // Only the proven chunks (and the one that wrote nothing) feed the key-ledger queries.
    expect(calls.find((c) => c.sql.includes('AS expected'))?.params).toEqual([[1, 3]]);
    const { pool: none } = fakePool([counts(5, 0), keyRows([1])]);
    expect(await tableCheck(none, twinMapping(), twinTable(), [ledgerRow({ id: 1, rows_inserted: 5 })], true)).toMatchObject({ expected: 0, actual: 0, foreign: 5, unproven: [rows[0]?.chunk_run_id] });
  });

  it('a chunk whose key rows fall short of its inserted rows (the ledger was switched off half-way) is unproven too', async () => {
    const rows = [ledgerRow({ id: 1, rows_inserted: 100 }), ledgerRow({ id: 2, chunk_run_id: 'x-audit_log-full-collection-rest', rows_inserted: 900, rows_updated: 10 })];
    // Chunk 2 inserted 900 rows but recorded 400 keys: the unrecorded 500 would never be reported as table_count.
    const { pool, calls } = fakePool([counts(1_000, 0), keyRows([], { 1: 100, 2: 400 }), expected(100), missing(0)]);
    const r = await tableCheck(pool, twinMapping(), twinTable(), rows, true);
    expect(r).toMatchObject({ drifts: [], expected: 100, actual: 100, unproven: ['x-audit_log-full-collection-rest'] });
    expect(calls.find((c) => c.sql.includes('AS expected'))?.params).toEqual([[1]]);
    // Updated rows need no new key row (the key was recorded when it was inserted), so key rows equal to rows_inserted prove a chunk with updates.
    const { pool: exact } = fakePool([counts(1_010, 0), keyRows([], { 1: 100, 2: 900 }), expected(1_000), missing(0)]);
    expect(await tableCheck(exact, twinMapping(), twinTable(), rows, true)).toMatchObject({ unproven: [], expected: 1_000 });
  });

  it('table_count names the missing keys with their chunk', async () => {
    const examples: Rule = [/SELECT k\.`key_value` AS key_value, MIN\(k\.`chunk_id`\) AS chunk_id/, (params) => {
      expect(params).toEqual([[1, 2]]);
      return [{ key_value: '65f1c0a1b2c3d4e5f6a7b8c9', chunk_id: '2' }, { key_value: '65f1c0a1b2c3d4e5f6a7b8ca', chunk_id: '1' }];
    }];
    const rows = [ledgerRow({ id: 1 }), ledgerRow({ id: 2, chunk_run_id: 'x-audit_log-full-collection-rest' })];
    const { pool, sqls } = fakePool([counts(998, 0), keyRows(), expected(1_000), missing(2), examples]);
    const r = await tableCheck(pool, twinMapping(), twinTable(), rows, true);
    expect(r.drifts).toEqual([{ table: 'audit_log_entries', kind: 'table_count', chunk: null, expected: 1_000, actual: 998,
      detail: '2 keys written by the selected chunks have no row: 65f1c0a1b2c3d4e5f6a7b8c9 (x-audit_log-full-collection-rest), 65f1c0a1b2c3d4e5f6a7b8ca (' + rows[0]?.chunk_run_id + ')' }]);
    expect(r.foreign).toBe(0);
    expect(sqls()[4]).toMatch(/GROUP BY k\.`key_value` ORDER BY k\.`key_value` LIMIT 20$/);
    const { pool: many } = fakePool([counts(0, 0), keyRows(), expected(1_000), missing(1_000), [/MIN\(k\.`chunk_id`\)/, Array.from({ length: 20 }, (_, i) => ({ key_value: `k${i}`, chunk_id: '1' }))]]);
    const big = await tableCheck(many, twinMapping(), twinTable(), [ledgerRow({ id: 1 })], true);
    expect(big.drifts[0]?.detail).toMatch(/^1,000 keys written by the selected chunks have no row; first 20: k0 \(.*\), k1 \(/);
  });

  it('without the key ledger no coverage query runs and foreign is estimated from the inserted counters', async () => {
    const { pool, sqls } = fakePool([counts(500, 3)]);
    const r = await tableCheck(pool, twinMapping(), twinTable(), [ledgerRow({ rows_inserted: 400 }), ledgerRow({ id: 2, status: 'loading', rows_inserted: 50 })], false);
    expect(r).toEqual({ drifts: [], keyed: 500, untracked: 3, foreign: 100, expected: null, actual: null, unproven: [] });
    expect(sqls()).toHaveLength(1);
    // Nothing selected: nothing to prove, the whole table is foreign.
    const { pool: empty } = fakePool([counts(5, 0)]);
    expect(await tableCheck(empty, twinMapping(), twinTable(), [], true)).toMatchObject({ foreign: 5, expected: null, actual: null });
  });

  it('a key ledger table that does not exist (loads ran with the ledger off) leaves every chunk that wrote rows unproven', async () => {
    const { pool } = fakePool([counts(10, 0), [/FROM `_msm_load_keys`/, () => { throw noSuchTable('_msm_load_keys'); }]]);
    const rows = [ledgerRow({ id: 1, rows_inserted: 10 }), ledgerRow({ id: 2, chunk_run_id: 'x-audit_log-manifest-only-full', rows_inserted: 0, exported_count: 0, lines_done: 0 })];
    const r = await tableCheck(pool, twinMapping(), twinTable(), rows, true);
    expect(r).toMatchObject({ drifts: [], expected: null, actual: null, foreign: 0, unproven: [rows[0]?.chunk_run_id] });
  });

  it('chunk column: tagged rows above the chunk bound, orphan tags, and tags carrying keys the chunk never wrote', async () => {
    const groups: Rule = [/^SELECT `_msm_chunk` AS chunk_id, COUNT\(\*\) AS tagged FROM `orders` WHERE `_msm_chunk` IS NOT NULL GROUP BY `_msm_chunk`$/,
      [{ chunk_id: '1', tagged: '60' }, { chunk_id: '2', tagged: '40' }, { chunk_id: '7', tagged: '3' }, { chunk_id: '8', tagged: '1' }]];
    const known: Rule = [/SELECT `id` FROM `_msm_load_chunks` WHERE `target_table` = \? AND `id` IN \(\?\)/, (params) => {
      expect(params).toEqual(['orders', [7, 8]]);
      return [{ id: '7' }];
    }];
    const strays: Rule = [/LEFT JOIN `_msm_load_keys` k ON k\.`chunk_id` = `orders`\.`_msm_chunk` AND k\.`key_value` = CONVERT\(`orders`\.`mongo_id` USING utf8mb4\) COLLATE utf8mb4_0900_bin WHERE `orders`\.`_msm_chunk` IN \(\?\) AND k\.`chunk_id` IS NULL GROUP BY `orders`\.`_msm_chunk`/,
      [{ chunk_id: '2', stray: '4' }]];
    const rows = [ledgerRow({ id: 1, target_table: 'orders', collection: 'orders', chunk_run_id: 'b-orders-full-collection-full', rows_inserted: 50, rows_updated: 10 }),
      ledgerRow({ id: 2, target_table: 'orders', collection: 'orders', chunk_run_id: 'b-orders-full-collection-rest', rows_inserted: 30, rows_updated: 5 })];
    const { pool } = fakePool([counts(104, 0), keyRows(), expected(100), missing(0), groups, known, strays]);
    const r = await tableCheck(pool, ordersMapping(), orders, rows, true);
    // Drifts follow the GROUP BY row order: chunk 1 within bound, chunk 2 over it, 7 known elsewhere, 8 orphan; then the stray keys.
    expect(r.drifts).toEqual([
      { table: 'orders', kind: 'chunk_count', chunk: 'b-orders-full-collection-rest', expected: 35, actual: 40, detail: '40 rows tagged with ledger id 2, but the chunk wrote 30 + 5 rows' },
      { table: 'orders', kind: 'orphan_chunk', chunk: null, expected: null, actual: 1, detail: '1 rows tagged _msm_chunk = 8, which is no load ledger row' },
      { table: 'orders', kind: 'chunk_count', chunk: 'b-orders-full-collection-rest', expected: 0, actual: 4, detail: '4 rows tagged with ledger id 2 carry keys that chunk never wrote' },
    ]);
  });

  it('chunk column without a key ledger checks only the bound; an absent ledger table makes every unknown tag an orphan', async () => {
    const groups: Rule = [/AS chunk_id, COUNT\(\*\) AS tagged/, [{ chunk_id: '1', tagged: '60' }, { chunk_id: '9', tagged: '2' }]];
    const { pool, sqls } = fakePool([counts(62, 0), groups, [/FROM `_msm_load_chunks`/, () => { throw noSuchTable('_msm_load_chunks'); }]]);
    const rows = [ledgerRow({ id: 1, target_table: 'orders', chunk_run_id: 'b-orders-full-collection-full', rows_inserted: 60 })];
    const r = await tableCheck(pool, ordersMapping(), orders, rows, false);
    expect(r.drifts).toEqual([expect.objectContaining({ kind: 'orphan_chunk', actual: 2 })]);
    expect(sqls().some((s) => s.includes('_msm_load_keys'))).toBe(false);
  });

  it('refuses a counter beyond 2^53 - 1 instead of rounding it', async () => {
    const { pool } = fakePool([counts(0, 0).map((x, i) => (i === 1 ? [{ keyed: '9007199254740992', untracked: '0' }] : x)) as Rule]);
    await expect(tableCheck(pool, twinMapping(), twinTable(), [], false)).rejects.toThrow(/keyed rows 9007199254740992 is outside 0\.\.2\^53-1/);
  });
});
