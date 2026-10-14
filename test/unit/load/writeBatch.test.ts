import { format, type SqlValue } from 'mysql2';
import { describe, expect, it } from 'vitest';
import writeBatch from '../../../src/load/writeBatch.js';
import type { LoadBatch, LoadRun, LoadTarget, TableInfo } from '../../../src/types.js';
import { exampleConfig, memoryContext } from '../../helpers.js';
import { ordersMapping, ordersTables } from '../mysql/fakeTables.js';
import { fakeMysql, header, tupleCount, type Rule } from '../mysql/fakeMysql.js';
import { reject, row, simpleMapping, simpleTable, target, type Row } from './fixtures.js';

const ledgerId = 7;
const k = (i: number): string => `65f1c0a1b2c3d4e5f6a7b8${String(i).padStart(2, '0')}`;
const tupleOf = (r: Row): string => format('(?)', [r.values as SqlValue[]]);
const rejectTuple = (r: ReturnType<typeof reject>): string => format('(?,?,?,?,UTC_TIMESTAMP(3))', [ledgerId, r.lineNo, r.reason, r.text]);

const childTuplesOf = (r: Row): Map<string, string[]> => new Map([...r.children].map(([t, rows]) => [t, rows.map((v) => format('(?)', [v as SqlValue[]]))]));

function batchOf(rows: Row[], rejects: ReturnType<typeof reject>[] = [], toLine = rows.length + rejects.length): LoadBatch {
  return { rows, rejects, toLine, tuples: rows.map(tupleOf), rejectTuples: rejects.map(rejectTuple), childTuples: rows.map(childTuplesOf) };
}

/** The steady-state answers: no existing keys, every INSERT inserts all its tuples, writes acknowledge. */
const baseRules = (existing: string[] = [], insertHeader?: ReturnType<typeof header>): Rule[] => [
  [/^START TRANSACTION$/, header(0)],
  [/FOR UPDATE$/, existing.map((key) => ({ source_mongo_id: key, mongo_id: key }))],
  [/^INSERT INTO `(audit_log_entries|orders)` /, (_p, sql) => insertHeader ?? header(tupleCount(sql), `Records: ${tupleCount(sql)}  Duplicates: 0  Warnings: 0`)],
  [/^DELETE FROM `orders_items`/, header(0)],
  [/^INSERT INTO `orders_items`/, (_p, sql) => header(tupleCount(sql))],
  [/^INSERT IGNORE INTO `_msm_load_rejects`/, header(0)],
  [/^INSERT IGNORE INTO `_msm_load_keys`/, header(0)],
  [/^UPDATE `_msm_load_chunks` SET `lines_done` = \?/, header(1)],
  [/^COMMIT$/, header(0)],
  [/^ROLLBACK$/, header(0)],
];

function setup(rules: Rule[], options: { keyLedger?: boolean; maxBatchBytes?: number; mapping?: 'simple' | 'orders' } = {}) {
  const config = exampleConfig({ load: { keyLedger: options.keyLedger ?? true } });
  const { ctx, store } = memoryContext({ command: 'load', config });
  const fake = fakeMysql(rules);
  const orders = ordersTables();
  const tgt: LoadTarget = options.mapping === 'orders'
    ? target(ordersMapping(), orders.get('orders') as TableInfo, new Map([['orders_items', orders.get('orders_items') as TableInfo]]))
    : target(simpleMapping(), simpleTable());
  const run: LoadRun = { ctx, store, mysql: fake.mysql, loadRunId: 'load-20261013T040000Z', maxBatchBytes: options.maxBatchBytes ?? 1024 * 1024, maxRowBytes: options.maxBatchBytes ?? 1024 * 1024, targets: new Map([[tgt.loaded.mapping.collection, tgt]]), locks: new Map(), batchCutoffs: new Map() };
  return { run, target: tgt, ...fake };
}

describe('writeBatch', () => {
  it('runs the documented statement sequence in one transaction on one pooled connection and releases it', async () => {
    const { run, target: t, sqls, calls, counts } = setup(baseRules());
    const rows = [row(k(1)), row(k(2), [k(2), 2])];
    const tally = await writeBatch(run, t, ledgerId, batchOf(rows));
    expect(tally).toEqual({ inserted: 2, updated: 0, duplicates: 0, rejected: 0, castErrors: 0 });
    expect(sqls()).toEqual([
      'START TRANSACTION',
      'SELECT `source_mongo_id` FROM `audit_log_entries` WHERE `source_mongo_id` IN (?) FOR UPDATE',
      `INSERT INTO \`audit_log_entries\` (\`source_mongo_id\`,\`n\`) VALUES ('${k(1)}', 1),('${k(2)}', 2) AS \`_msm_new\` ON DUPLICATE KEY UPDATE \`n\` = \`_msm_new\`.\`n\``,
      `INSERT IGNORE INTO \`_msm_load_keys\` (\`chunk_id\`,\`key_value\`) VALUES (7,'${k(1)}'),(7,'${k(2)}')`,
      'UPDATE `_msm_load_chunks` SET `lines_done` = ?, `rows_inserted` = `rows_inserted` + ?, `rows_updated` = `rows_updated` + ?, `duplicates_skipped` = `duplicates_skipped` + ?, `rows_rejected` = `rows_rejected` + ?, `cast_errors` = `cast_errors` + ?, `updated_at` = UTC_TIMESTAMP(3) WHERE `id` = ?',
      'COMMIT',
    ]);
    expect(calls.every((c) => c.conn === 'tx')).toBe(true);
    expect(calls[1]?.params).toEqual([[k(1), k(2)]]);
    expect(calls[4]?.params).toEqual([2, 2, 0, 0, 0, 0, ledgerId]);
    expect(counts).toMatchObject({ released: 1, destroyed: 0 });
  });

  it('dedupes by key, the last line of a key wins and the earlier copies count as duplicates', async () => {
    const { run, target: t, sqls, calls } = setup(baseRules());
    const rows = [row(k(1), [k(1), 1]), row(k(2), [k(2), 2]), row(k(1), [k(1), 3], { castErrors: 1 })];
    const tally = await writeBatch(run, t, ledgerId, batchOf(rows));
    expect(tally).toEqual({ inserted: 2, updated: 0, duplicates: 1, rejected: 0, castErrors: 1 });
    const insert = sqls().find((s) => s.startsWith('INSERT INTO `audit_log_entries`')) as string;
    expect(insert).toContain(`VALUES ('${k(2)}', 2),('${k(1)}', 3) AS`);
    expect(insert).not.toContain(`('${k(1)}', 1)`);
    expect(calls[1]?.params).toEqual([[k(2), k(1)]]);
    expect(calls.find((c) => c.sql.startsWith('UPDATE `_msm_load_chunks`'))?.params).toEqual([3, 2, 0, 1, 0, 1, ledgerId]);
  });

  it('keys found by the SELECT are updates whether or not their values changed (Duplicates: 0 for unchanged rows)', async () => {
    const { run, target: t } = setup(baseRules([k(1), k(2)], header(0, 'Records: 2  Duplicates: 0  Warnings: 0')));
    const tally = await writeBatch(run, t, ledgerId, batchOf([row(k(1)), row(k(2))]));
    expect(tally).toEqual({ inserted: 0, updated: 2, duplicates: 0, rejected: 0, castErrors: 0 });
  });

  it('a mixed batch: affectedRows = inserted + 2 x changed and Duplicates = changed rows', async () => {
    const { run, target: t } = setup(baseRules([k(2)], header(4, 'Records: 3  Duplicates: 1  Warnings: 0')));
    const tally = await writeBatch(run, t, ledgerId, batchOf([row(k(1)), row(k(2)), row(k(3))]));
    expect(tally).toMatchObject({ inserted: 2, updated: 1 });
  });

  it.each<[string, string[], number, { inserted: number; updated: number }]>([
    ['new', [], 1, { inserted: 1, updated: 0 }],
    ['existing and changed', [k(1)], 2, { inserted: 0, updated: 1 }],
    ['existing and unchanged', [k(1)], 0, { inserted: 0, updated: 1 }],
  ])('a one-row statement has no info line, so affectedRows alone decides: %s', async (_, existing, affected, expected) => {
    const { run, target: t } = setup(baseRules(existing, header(affected)));
    expect(await writeBatch(run, t, ledgerId, batchOf([row(k(1))]))).toMatchObject(expected);
  });

  it('a key another writer inserted between the SELECT and the INSERT rolls back as a retriable insert_race', async () => {
    const { run, target: t, sqls, counts } = setup(baseRules([], header(3, 'Records: 2  Duplicates: 1  Warnings: 0')));
    await expect(writeBatch(run, t, ledgerId, batchOf([row(k(1)), row(k(2))]))).rejects.toMatchObject({
      msmCode: 'insert_race', retriable: true, fatal: false, message: 'audit_log_entries: 1 rows inserted, 2 expected; another writer inserted a key',
    });
    expect(sqls().at(-1)).toBe('ROLLBACK');
    expect(sqls()).not.toContain('COMMIT');
    expect(sqls().some((s) => s.startsWith('INSERT IGNORE INTO `_msm_load_keys`'))).toBe(false);
    expect(counts).toMatchObject({ released: 1, destroyed: 0 });
  });

  it('a one-row race (affectedRows 2 with nothing selected) is detected the same way', async () => {
    const { run, target: t } = setup(baseRules([], header(2)));
    await expect(writeBatch(run, t, ledgerId, batchOf([row(k(1))]))).rejects.toMatchObject({ msmCode: 'insert_race' });
  });

  it('replaces child rows: DELETE by parent key, then INSERT in the mapping column order with the array index', async () => {
    const { run, target: t, sqls, calls } = setup(baseRules(), { mapping: 'orders' });
    const children = new Map([['orders_items', [[k(1), 0, 'sku-1', 2, '9.99'], [k(1), 1, 'sku-2', 1, '0.50']]]]);
    const rows = [row(k(1), [k(1), 'paid', '19.99', '5', 1, '2026-03-02 00:00:00.000', null, null, 'load-x', ledgerId, null], { children }), row(k(2), [k(2), null, null, null, null, null, null, null, 'load-x', ledgerId, null])];
    await writeBatch(run, t, ledgerId, batchOf(rows));
    const s = sqls();
    expect(s[1]).toBe('SELECT `mongo_id` FROM `orders` WHERE `mongo_id` IN (?) FOR UPDATE');
    expect(s[2]).toMatch(/^INSERT INTO `orders` \(`mongo_id`,`status`,`total`,`sequence`,`paid`,`created_at`,`customer`,`tags`,`import_run`,`_msm_chunk`,`_extra`\) VALUES /);
    expect(s[3]).toBe('DELETE FROM `orders_items` WHERE `order_mongo_id` IN (?)');
    expect(calls[3]?.params).toEqual([[k(1), k(2)]]);
    expect(s[4]).toBe(`INSERT INTO \`orders_items\` (\`order_mongo_id\`,\`item_index\`,\`sku\`,\`qty\`,\`price\`) VALUES ('${k(1)}', 0, 'sku-1', 2, '9.99'),('${k(1)}', 1, 'sku-2', 1, '0.50')`);
    expect(s[5]).toMatch(/^INSERT IGNORE INTO `_msm_load_keys`/);
  });

  it('a parent without child rows still deletes its old children and skips the empty INSERT', async () => {
    const { run, target: t, sqls } = setup(baseRules(), { mapping: 'orders' });
    await writeBatch(run, t, ledgerId, batchOf([row(k(1), [k(1), null, null, null, null, null, null, null, 'load-x', ledgerId, null])]));
    expect(sqls().filter((s) => s.startsWith('DELETE FROM `orders_items`'))).toHaveLength(1);
    expect(sqls().some((s) => s.startsWith('INSERT INTO `orders_items`'))).toBe(false);
  });

  it('splits child, reject and key INSERTs at maxBatchBytes; the main upsert is never split', async () => {
    const { run, target: t, sqls } = setup(baseRules(), { mapping: 'orders', maxBatchBytes: 160 });
    const children = new Map([['orders_items', Array.from({ length: 6 }, (_, i) => [k(1), i, `sku-${i}`, 1, '1.00'])]]);
    const rows = [row(k(1), [k(1), null, null, null, null, null, null, null, 'load-x', ledgerId, null], { children })];
    const rejects = Array.from({ length: 5 }, (_, i) => reject(10 + i, 'bad', 'x'.repeat(40)));
    await writeBatch(run, t, ledgerId, batchOf(rows, rejects));
    const s = sqls();
    const childInserts = s.filter((x) => x.startsWith('INSERT INTO `orders_items`'));
    expect(childInserts.length).toBeGreaterThan(1);
    expect(childInserts.flatMap((x) => x.match(/\('65f1/g) ?? [])).toHaveLength(6);
    for (const x of childInserts) expect(Buffer.byteLength(x, 'utf8')).toBeLessThanOrEqual(160);
    const rejectInserts = s.filter((x) => x.startsWith('INSERT IGNORE INTO `_msm_load_rejects`'));
    expect(rejectInserts.length).toBeGreaterThan(1);
    expect(rejectInserts.flatMap((x) => x.match(/\(7,1\d,/g) ?? [])).toHaveLength(5);
    expect(s.filter((x) => x.startsWith('INSERT INTO `orders` '))).toHaveLength(1);
  });

  it('records rejects with INSERT IGNORE and counts them; without the key ledger no keys statement runs', async () => {
    const { run, target: t, sqls, calls } = setup(baseRules(), { keyLedger: false });
    const rejects = [reject(3, 'invalid JSON: bad', '{ broken'), reject(5, '_id: not an ObjectId', '{"_id":1}')];
    const tally = await writeBatch(run, t, ledgerId, batchOf([row(k(1))], rejects, 5));
    expect(tally).toEqual({ inserted: 1, updated: 0, duplicates: 0, rejected: 2, castErrors: 0 });
    expect(sqls().find((s) => s.startsWith('INSERT IGNORE INTO `_msm_load_rejects`'))).toBe(
      `INSERT IGNORE INTO \`_msm_load_rejects\` (\`chunk_id\`,\`line_no\`,\`reason\`,\`line_text\`,\`created_at\`) VALUES (7,3,'invalid JSON: bad','{ broken',UTC_TIMESTAMP(3)),(7,5,'_id: not an ObjectId','{\\"_id\\":1}',UTC_TIMESTAMP(3))`,
    );
    expect(sqls().some((s) => s.includes('_msm_load_keys'))).toBe(false);
    expect(calls.find((c) => c.sql.startsWith('UPDATE `_msm_load_chunks`'))?.params).toEqual([5, 1, 0, 0, 2, 0, ledgerId]);
  });

  it('a batch of only rejects touches neither the target table nor the key ledger', async () => {
    const { run, target: t, sqls } = setup(baseRules());
    const tally = await writeBatch(run, t, ledgerId, batchOf([], [reject(1), reject(2)]));
    expect(tally).toEqual({ inserted: 0, updated: 0, duplicates: 0, rejected: 2, castErrors: 0 });
    expect(sqls()).toEqual([
      'START TRANSACTION',
      expect.stringMatching(/^INSERT IGNORE INTO `_msm_load_rejects`/),
      expect.stringMatching(/^UPDATE `_msm_load_chunks` SET `lines_done` = \?/),
      'COMMIT',
    ]);
  });

  it('a failing statement rolls back, releases the connection and rethrows the error', async () => {
    const boom = Object.assign(new Error('Data too long for column'), { errno: 1406, sqlState: '22001' });
    const rules: Rule[] = [[/^INSERT INTO `audit_log_entries`/, () => { throw boom; }], ...baseRules()];
    const { run, target: t, sqls, counts } = setup(rules);
    await expect(writeBatch(run, t, ledgerId, batchOf([row(k(1))]))).rejects.toBe(boom);
    expect(sqls().at(-1)).toBe('ROLLBACK');
    expect(sqls()).not.toContain('COMMIT');
    expect(counts).toMatchObject({ released: 1, destroyed: 0 });
  });

  it('every statement carries the 10 minute timeout, START TRANSACTION, COMMIT and ROLLBACK included, and a timed-out statement destroys the connection instead of queueing a ROLLBACK behind it', async () => {
    const { run, target: t1, calls } = setup(baseRules());
    const ok = await writeBatch(run, t1, ledgerId, batchOf([row(k(1))]));
    expect(ok.inserted).toBe(1);
    const timeouts = calls.filter((c) => c.conn === 'tx').map((c) => [c.sql.split(' ').slice(0, 2).join(' '), c.timeout]);
    expect(timeouts).toEqual([
      ['START TRANSACTION', 600_000], ['SELECT `source_mongo_id`', 600_000], ['INSERT INTO', 600_000], ['INSERT IGNORE', 600_000],
      ['UPDATE `_msm_load_chunks`', 600_000], ['COMMIT', 600_000],
    ]);
    const failing = setup([[/^INSERT INTO `audit_log_entries`/, () => { throw Object.assign(new Error('Deadlock'), { errno: 1213, sqlState: '40001' }); }], ...baseRules()]);
    await expect(writeBatch(failing.run, failing.target, ledgerId, batchOf([row(k(1))]))).rejects.toMatchObject({ errno: 1213 });
    expect(failing.calls.find((c) => c.sql === 'ROLLBACK')?.timeout).toBe(600_000);
    // mysql2 rejects the timed-out query but keeps it as the connection's current command: a ROLLBACK would wait for the socket to die.
    const stalled = Object.assign(new Error('Query inactivity timeout'), { code: 'PROTOCOL_SEQUENCE_TIMEOUT', fatal: true });
    const t = setup([[/^INSERT INTO `audit_log_entries` /, () => { throw stalled; }], ...baseRules()]);
    await expect(writeBatch(t.run, t.target, ledgerId, batchOf([row(k(2))]))).rejects.toBe(stalled);
    expect(t.sqls().includes('ROLLBACK')).toBe(false);
    expect(t.counts).toMatchObject({ released: 0, destroyed: 1 });
  });

  it('when the ROLLBACK itself fails the connection is destroyed, not returned to the pool', async () => {
    const lost = Object.assign(new Error('Connection lost'), { code: 'PROTOCOL_CONNECTION_LOST' });
    const rules: Rule[] = [[/^COMMIT$/, () => { throw lost; }], [/^ROLLBACK$/, () => { throw lost; }], ...baseRules()];
    const { run, target: t, counts } = setup(rules);
    await expect(writeBatch(run, t, ledgerId, batchOf([row(k(1))]))).rejects.toBe(lost);
    expect(counts).toMatchObject({ released: 0, destroyed: 1 });
  });

  it('a failure before the transaction opened releases the connection without a ROLLBACK', async () => {
    const down = Object.assign(new Error('server shutdown'), { errno: 1053 });
    const { run, target: t, sqls, counts } = setup([[/^START TRANSACTION$/, () => { throw down; }]]);
    await expect(writeBatch(run, t, ledgerId, batchOf([row(k(1))]))).rejects.toBe(down);
    expect(sqls()).toEqual(['START TRANSACTION']);
    expect(counts).toMatchObject({ released: 1, destroyed: 0 });
  });

  it('child tuples the batcher already formatted are sent as they are, and a deduped parent loses its child rows too', async () => {
    const { run, target: t, sqls } = setup(baseRules(), { mapping: 'orders' });
    const first = row(k(1), [k(1), null, null, null, null, null, null, null, 'load-x', ledgerId, null], { children: new Map([['orders_items', [[k(1), 0, 'old', 1, '1.00']]]]) });
    const last = row(k(1), [k(1), null, null, null, null, null, null, null, 'load-x', ledgerId, null], { children: new Map([['orders_items', [[k(1), 0, 'new', 2, '2.00']]]]) });
    const batch = batchOf([first, last]);
    // A tuple the batcher formatted is the one sent, whatever the raw child rows say.
    batch.childTuples[1] = new Map([['orders_items', [`('${k(1)}', 0, 'formatted-once', 2, '2.00')`]]]);
    await writeBatch(run, t, ledgerId, batch);
    const inserts = sqls().filter((x) => x.startsWith('INSERT INTO `orders_items`'));
    expect(inserts).toEqual([`INSERT INTO \`orders_items\` (\`order_mongo_id\`,\`item_index\`,\`sku\`,\`qty\`,\`price\`) VALUES ('${k(1)}', 0, 'formatted-once', 2, '2.00')`]);
  });

  it('the key ledger tuples carry the ledger id and the cast key, one per written (deduped) row', async () => {
    const { run, target: t, sqls } = setup(baseRules());
    await writeBatch(run, t, ledgerId, batchOf([row(k(1)), row(k(1), [k(1), 9]), row(k(2))]));
    expect(sqls().find((s) => s.startsWith('INSERT IGNORE INTO `_msm_load_keys`'))).toBe(`INSERT IGNORE INTO \`_msm_load_keys\` (\`chunk_id\`,\`key_value\`) VALUES (7,'${k(1)}'),(7,'${k(2)}')`);
  });
});
