import type { Connection, Pool, PoolConnection, ResultSetHeader } from 'mysql2/promise';
import type { MysqlHandle } from '../../../src/types.js';

/** `timeout`: the mysql2 query timeout the statement carried, when it was passed as `{ sql, timeout }`. */
export interface Call { sql: string; params: unknown[]; conn: 'pool' | 'tx' | 'lock'; timeout?: number }
/** A scripted answer: rows, a ResultSetHeader, or a function of the params and SQL that returns either. */
export type Answer = unknown[] | ResultSetHeader | ((params: unknown[], sql: string) => unknown);
export type Rule = [RegExp, Answer];

/** What mysql2 returns for a write statement; `info` is the "Records: n  Duplicates: n" line of multi-row INSERTs. */
export const header = (affectedRows: number, info = ''): ResultSetHeader =>
  ({ affectedRows, insertId: 0, info, warningStatus: 0, fieldCount: 0, serverStatus: 2, changedRows: 0 } as ResultSetHeader);

/**
 * A MysqlHandle whose every connection answers from rules in order, recording each statement with the
 * connection it ran on: `pool` for pool.query, `tx` for the pooled connection writeBatch takes, `lock`
 * for the dedicated GET_LOCK holder. Unscripted SQL throws, so a test cannot pass on a statement it never
 * expected. Values are strings where mysql2 would give strings (`bigNumberStrings`).
 */
export function fakeMysql(rules: Rule[], options: { maxAllowedPacket?: number; lockAvailable?: boolean } = {}) {
  const calls: Call[] = [];
  const counts = { released: 0, destroyed: 0, ended: 0, connected: 0, lockDestroyed: 0 };
  // mysql2 accepts `{ sql, timeout }` in place of the text; the fake records the text and the timeout.
  const answer = (conn: Call['conn']) => async (query: string | { sql: string; timeout?: number }, params: unknown[] = []): Promise<[unknown, unknown[]]> => {
    const sql = typeof query === 'string' ? query : query.sql;
    calls.push({ sql, params, conn, ...(typeof query === 'object' && query.timeout !== undefined ? { timeout: query.timeout } : {}) });
    for (const [pattern, result] of rules) {
      if (pattern.test(sql)) return [typeof result === 'function' ? await result(params, sql) : result, []];
    }
    throw new Error(`unscripted SQL: ${sql}`);
  };
  const conn = {
    query: answer('tx'),
    release() { counts.released += 1; },
    destroy() { counts.destroyed += 1; },
  } as unknown as PoolConnection;
  const pool = {
    query: answer('pool'),
    async getConnection() { return conn; },
    async end() {},
  } as unknown as Pool;
  const mysql: MysqlHandle = {
    pool, maxAllowedPacket: options.maxAllowedPacket ?? 64 * 1024 * 1024, version: '8.0.36',
    async connect() {
      counts.connected += 1;
      return { query: answer('lock'), async end() { counts.ended += 1; }, destroy() { counts.lockDestroyed += 1; } } as unknown as Connection;
    },
    async close() {},
  };
  return { mysql, pool, conn, calls, counts, sqls: (on?: Call['conn']) => calls.filter((c) => on === undefined || c.conn === on).map((c) => c.sql) };
}

/** Counts the tuples of a multi-row VALUES list: what a real server would report as Records. */
export const tupleCount = (sql: string): number => {
  const start = sql.indexOf('VALUES ') + 'VALUES '.length;
  const end = sql.indexOf(' AS `_msm_new`');
  return sql.slice(start, end === -1 ? undefined : end).split('),(').length;
};

/**
 * The reconcile-side view of the same fake: one pool whose `query` answers from the rules (a `PoolConnection`
 * from `getConnection` records on the same list), with the release count the deep check's tests assert.
 */
export function fakePool(rules: Rule[]) {
  const t = fakeMysql(rules);
  return { pool: t.pool, conn: t.conn, mysql: t.mysql, calls: t.calls, released: () => t.counts.released, sqls: () => t.sqls() };
}
