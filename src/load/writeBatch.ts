import { format } from 'mysql2';
import type { SqlValue } from 'mysql2';
import type { PoolConnection, ResultSetHeader } from 'mysql2/promise';
import quoteId from '#mysql/quoteId';
import upsertSql from '#mysql/upsertSql';
import formatCount from '#runtime/formatCount';
import msmError from '#runtime/msmError';
import type { BatchTally, LoadBatch, LoadRun, LoadTarget, RowResult } from '#types';

/**
 * Generous for one statement of a batch; a statement that takes longer sits on a half-open socket
 * and should fail the attempt, not hang it.
 */
const statementTimeoutMs = 600_000;
const timed = (sql: string) => ({ sql, timeout: statementTimeoutMs });

/**
 * mysql2 rejects a timed-out query but keeps it as the connection's current command, so the next
 * statement would wait for the socket to die.
 */
const timedOut = (err: unknown): boolean =>
  (err as { code?: unknown })?.code === 'PROTOCOL_SEQUENCE_TIMEOUT';

/**
 * Multi-row INSERTs that may be larger than one packet (children, rejects, keys) are cut at
 * `maxBytes`.
 */
function splitStatements(head: string, tuples: readonly string[], maxBytes: number): string[] {
  const statements: string[] = [];
  const headBytes = Buffer.byteLength(head, 'utf8');
  let current: string[] = [];
  let bytes = headBytes;

  for (const tuple of tuples) {
    const size = Buffer.byteLength(tuple, 'utf8') + 1;

    if (current.length > 0 && bytes + size > maxBytes) {
      statements.push(`${head}${current.join(',')}`);
      current = [];
      bytes = headBytes;
    }

    current.push(tuple);
    bytes += size;
  }

  if (current.length > 0) statements.push(`${head}${current.join(',')}`);

  return statements;
}

/**
 * Rows this statement inserted. With FOUND_ROWS off, `affectedRows` is inserted plus twice the
 * changed rows and `info` carries the changed count as Duplicates; a one-row statement has no
 * `info`, so its `affectedRows` alone tells: 1 inserted, 0 unchanged, 2 changed.
 */
function insertedRows(header: ResultSetHeader, rows: number): number {
  if (rows === 1) return header.affectedRows === 1 ? 1 : 0;

  const m = /Duplicates:\s*(\d+)/.exec(header.info ?? '');

  return header.affectedRows - 2 * (m ? Number(m[1]) : 0);
}

/**
 * The last line of each key wins inside a batch; earlier copies are counted, not written, their
 * child rows included.
 */
function dedupe(batch: LoadBatch): {
  rows: RowResult[];
  tuples: string[];
  childTuples: Map<string, string[]>[];
  duplicates: number;
} {
  const last = new Map<string, number>();

  batch.rows.forEach((row, i) => last.set(row.key, i));

  const rows: RowResult[] = [];
  const tuples: string[] = [];
  const childTuples: Map<string, string[]>[] = [];

  batch.rows.forEach((row, i) => {
    if (last.get(row.key) !== i) return;

    rows.push(row);
    tuples.push(batch.tuples[i] as string);
    childTuples.push(batch.childTuples[i] ?? new Map());
  });

  return { rows, tuples, childTuples, duplicates: batch.rows.length - rows.length };
}

async function writeRows(
  conn: PoolConnection,
  run: LoadRun,
  target: LoadTarget,
  rows: RowResult[],
  tuples: string[],
  childTuples: Map<string, string[]>[]
): Promise<{ inserted: number; updated: number }> {
  const { mapping } = target.loaded;
  const table = quoteId(target.table.name);
  const keyColumn = quoteId(mapping.key.column);
  const keys = rows.map(r => r.key);

  const [existingRows] = await conn.query(
    timed(`SELECT ${keyColumn} FROM ${table} WHERE ${keyColumn} IN (?) FOR UPDATE`),
    [keys]
  );

  const existing = (existingRows as unknown[]).length;

  const { head, tail } = upsertSql(target.table.name, target.columns, mapping.key.column);
  const [header] = await conn.query(timed(`${head}${tuples.join(',')}${tail}`));
  const inserted = insertedRows(header as ResultSetHeader, rows.length);

  if (inserted !== rows.length - existing) {
    throw msmError(
      'insert_race',
      `${target.table.name}: ${formatCount(inserted)} rows inserted, ` +
        `${formatCount(rows.length - existing)} expected; another writer inserted a ` +
        'key',
      { retriable: true }
    );
  }

  for (const child of mapping.children) {
    const childTable = quoteId(child.table);

    await conn.query(
      timed(`DELETE FROM ${childTable} WHERE ${quoteId(child.parentColumn)} IN (?)`),
      [keys]
    );

    const columns = [
      child.parentColumn,
      ...(child.indexColumn === null ? [] : [child.indexColumn]),
      ...child.columns.map(c => c.column),
    ];

    // The tuples were formatted once in loadChunk (the batcher budgeted them); a row without them
    // falls back to its raw child rows.
    const tuples = rows.flatMap(
      (r, i) =>
        childTuples[i]?.get(child.table) ??
        (r.children.get(child.table) ?? []).map(values => format('(?)', [values as SqlValue[]]))
    );

    const childHead = `INSERT INTO ${childTable} (${columns.map(quoteId).join(',')}) VALUES `;

    for (const sql of splitStatements(childHead, tuples, run.maxBatchBytes))
      await conn.query(timed(sql));
  }

  return { inserted, updated: existing };
}

/**
 * One batch in one transaction: lock the existing keys, upsert the rows, replace their child rows,
 * record rejects and keys, advance the ledger, commit. Any error rolls back and rethrows; the chunk
 * attempt resumes from `lines_done`, which also covers a COMMIT whose acknowledgement was lost.
 * Every statement carries the timeout, START TRANSACTION, COMMIT and ROLLBACK included (a COMMIT on
 * a half-open socket or behind a global read lock would otherwise wait as long as the OS or the
 * backup does); after a timeout the connection is destroyed instead (the server rolls back when the
 * session drops), so the attempt fails within the timeout.
 */
export default async function writeBatch(
  run: LoadRun,
  target: LoadTarget,
  ledgerId: number,
  batch: LoadBatch
): Promise<BatchTally> {
  const { rows, tuples, childTuples, duplicates } = dedupe(batch);

  const tally: BatchTally = {
    inserted: 0,
    updated: 0,
    duplicates,
    rejected: batch.rejects.length,
    castErrors: rows.reduce((sum, r) => sum + r.castErrors, 0),
  };

  const conn = await run.mysql.pool.getConnection();
  let open = false;

  try {
    await conn.query(timed('START TRANSACTION'));
    open = true;

    if (rows.length > 0) {
      const written = await writeRows(conn, run, target, rows, tuples, childTuples);

      tally.inserted = written.inserted;
      tally.updated = written.updated;
    }

    const rejectHead =
      'INSERT IGNORE INTO `_msm_load_rejects` ' +
      '(`chunk_id`,`line_no`,`reason`,`line_text`,`created_at`) VALUES ';

    for (const sql of splitStatements(rejectHead, batch.rejectTuples, run.maxBatchBytes))
      await conn.query(timed(sql));

    if (run.ctx.config.load.keyLedger && rows.length > 0) {
      const keyHead = 'INSERT IGNORE INTO `_msm_load_keys` (`chunk_id`,`key_value`) VALUES ';
      const keyTuples = rows.map(r => format('(?,?)', [ledgerId, r.key]));

      for (const sql of splitStatements(keyHead, keyTuples, run.maxBatchBytes))
        await conn.query(timed(sql));
    }

    await conn.query(
      timed(
        'UPDATE `_msm_load_chunks` SET `lines_done` = ?, `rows_inserted` = ' +
          '`rows_inserted` + ?, `rows_updated` = `rows_updated` + ?, ' +
          ('`duplicates_skipped` = `duplicates_skipped` + ?, `rows_rejected` = ' +
            '`rows_rejected` + ?, `cast_errors` = `cast_errors` + ?, ') +
          '`updated_at` = UTC_TIMESTAMP(3) WHERE `id` = ?'
      ),
      [
        batch.toLine,
        tally.inserted,
        tally.updated,
        tally.duplicates,
        tally.rejected,
        tally.castErrors,
        ledgerId,
      ]
    );

    await conn.query(timed('COMMIT'));
    open = false;
    conn.release();

    return tally;
  } catch (err) {
    if (timedOut(err)) conn.destroy();
    else if (open) {
      try {
        await conn.query(timed('ROLLBACK'));
        conn.release();
      } catch {
        // The connection is in an unknown state (lost mid-transaction); the pool must not hand it
        // out again.
        conn.destroy();
      }
    } else {
      conn.release();
    }

    throw err;
  }
}
