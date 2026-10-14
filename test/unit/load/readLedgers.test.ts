import { describe, expect, it } from 'vitest';
import readLedgers from '../../../src/load/readLedgers.js';
import type { LoadTarget } from '../../../src/types.js';
import { memoryContext } from '../../helpers.js';
import { fakeMysql } from '../mysql/fakeMysql.js';
import { ledgerRow, simpleMapping, simpleTable, target } from './fixtures.js';

const asDb = (rows: ReturnType<typeof ledgerRow>[]) => rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'number' ? String(v) : v])));

describe('readLedgers', () => {
  it('reads each target table once, however many collections share it, and keys the rows by table', async () => {
    const { ctx } = memoryContext({ command: 'load' });
    const rows = [ledgerRow({ id: 1 }), ledgerRow({ id: 2, collection: 'audit_log_old', chunk_run_id: 'x-audit_log_old-full-collection-full' })];
    const { pool, calls } = fakeMysql([[/FROM `_msm_load_chunks` WHERE `target_table` = \?/, (params) => (params[0] === 'audit_log_entries' ? asDb(rows) : [])]]);
    const shared = target(simpleMapping(), simpleTable());
    const other: LoadTarget = target({ ...simpleMapping(), collection: 'orders', table: 'orders' }, { ...simpleTable(), name: 'orders' });
    const targets = new Map<string, LoadTarget>([['audit_log', shared], ['audit_log_old', shared], ['orders', other]]);
    const ledgers = await readLedgers(ctx, pool, targets);
    expect([...ledgers.keys()]).toEqual(['audit_log_entries', 'orders']);
    expect(ledgers.get('audit_log_entries')?.map((r) => r.id)).toEqual([1, 2]);
    expect(ledgers.get('orders')).toEqual([]);
    expect(calls.map((c) => c.params[0])).toEqual(['audit_log_entries', 'orders']);
  });

  it('retries a transient read and gives up on an abort with interrupted', async () => {
    const { ctx, events } = memoryContext({ command: 'load' });
    let attempts = 0;
    const { pool } = fakeMysql([[/FROM `_msm_load_chunks`/, () => { attempts += 1; if (attempts === 1) throw Object.assign(new Error('lost'), { code: 'PROTOCOL_CONNECTION_LOST' }); return []; }]]);
    const targets = new Map<string, LoadTarget>([['audit_log', target(simpleMapping(), simpleTable())]]);
    expect(await readLedgers(ctx, pool, targets)).toEqual(new Map([['audit_log_entries', []]]));
    expect(attempts).toBe(2);
    expect(events.filter((e) => e.type === 'retry')).toHaveLength(1);
    const controller = new AbortController();
    controller.abort('SIGINT');
    const aborted = memoryContext({ command: 'load', signal: controller.signal });
    await expect(readLedgers(aborted.ctx, pool, targets)).rejects.toMatchObject({ msmCode: 'interrupted', message: 'readLedger: interrupted' });
  });
});
