import { createReadStream } from 'node:fs';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import isObject from '#ejson/isObject';
import readGzipLines from '#ejson/readGzipLines';
import downloadPart from '#load/downloadPart';
import partPath from '#load/partPath';
import castValue from '#mapping/castValue';
import isNoSuchTable from '#mysql/isNoSuchTable';
import keyLedgerKey from '#mysql/keyLedgerKey';
import quoteId from '#mysql/quoteId';
import toSafeNumber from '#mysql/toSafeNumber';
import driftSample from '#reconcile/driftSample';
import keyExpr from '#reconcile/keyExpr';
import formatCount from '#runtime/formatCount';
import msmError from '#runtime/msmError';
import tempDirOf from '#runtime/tempDirOf';
import withRetry from '#runtime/withRetry';
import type { Drift, LedgerRow, Mapping, ReconcileRun, ResolvedManifest, TableInfo } from '#types';

const idsTable = '`_msm_ids`';
const insertRows = 1000;

/**
 * The key the load would have upserted on, or null for a line load would have rejected before
 * casting columns.
 */
function keyOf(line: string, mapping: Mapping, table: TableInfo): string | null {
  let doc: unknown;

  try {
    doc = JSON.parse(line);
  } catch {
    return null;
  }

  if (!isObject(doc)) return null;

  const cast = castValue(
    doc._id,
    { cast: `key-${mapping.key.cast}` },
    table.columns.get(mapping.key.column) ?? null
  );

  return cast.ok ? String(cast.value) : null;
}

/**
 * The line numbers `_msm_load_rejects` records for one chunk, ascending, read as that chunk is
 * reached so memory is bounded by one chunk's rejects and not by every chunk's; a database without
 * the table has none.
 */
async function rejectedLines(
  query: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>,
  chunkId: number
): Promise<number[]> {
  let rows: Record<string, unknown>[];

  try {
    rows = await query(
      'SELECT `line_no` FROM `_msm_load_rejects` WHERE `chunk_id` = ? ORDER BY `line_no`',
      [chunkId]
    );
  } catch (err) {
    if (isNoSuchTable(err)) return [];

    throw err;
  }

  return rows.map(r => toSafeNumber(r.line_no, '_msm_load_rejects.line_no'));
}

/**
 * The full proof: every key of the selected chunks' parts goes into a temporary table on one
 * connection, then one anti-join finds keys without a row and, when the selection is the whole
 * ledger, one NOT EXISTS finds keyed rows no loaded batch wrote. Lines the load rejected (recorded
 * in `_msm_load_rejects`, or a line whose `_id` the key cast refuses) and lines past an unfinished
 * chunk's `lines_done` are skipped: they have no row by design and are reported elsewhere. A key
 * longer than the id table's column would be truncated by INSERT IGNORE and merged with its
 * neighbours into false drifts, so it ends the check instead. It reads the archive once and is the
 * only coverage proof when the key ledger is off.
 */
export default async function deepCheck(
  run: ReconcileRun,
  mapping: Mapping,
  table: TableInfo,
  selected: LedgerRow[],
  manifests: ResolvedManifest[],
  whole: boolean
): Promise<{ drifts: Drift[]; distinct: number }> {
  const { ctx } = run;
  // Chunks without a ledger row are already `not_loaded`; the ids read here are the ones the ledger
  // claims, in ledger order, so the progress follows the order the load applied them in.
  const byRunId = new Map(manifests.map(m => [m.runId, m]));

  const chunks = selected
    .map(row => ({ row, resolved: byRunId.get(row.chunk_run_id) }))
    .filter(
      (c): c is { row: LedgerRow; resolved: ResolvedManifest } =>
        c.resolved !== undefined && c.resolved.parts.length > 0
    );

  const t = quoteId(table.name);
  const key = quoteId(mapping.key.column);
  const expr = keyExpr(table.columns.get(mapping.key.column) ?? null, mapping.key.cast);
  const tempRoot = tempDirOf(ctx.config, 'reconcile');

  const conn = await run.mysql.pool.getConnection();

  const query = async (sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> => {
    const [result] = await conn.query(sql, params);

    return result as Record<string, unknown>[];
  };

  let distinct = 0;
  const drifts: Drift[] = [];

  try {
    await query(`DROP TEMPORARY TABLE IF EXISTS ${idsTable}`);

    await query(
      `CREATE TEMPORARY TABLE ${idsTable} (\`id\` ` +
        `VARCHAR(${keyLedgerKey.maxChars}) COLLATE ${keyLedgerKey.collation} PRIMARY ` +
        'KEY)'
    );

    const total = chunks.reduce((sum, c) => sum + c.resolved.parts.length, 0);
    let done = 0;
    let docs = 0;
    let pending: string[][] = [];

    const flush = async () => {
      if (pending.length === 0) return;

      await query(`INSERT IGNORE INTO ${idsTable} (\`id\`) VALUES ?`, [pending]);
      pending = [];
    };

    for (const { row, resolved } of chunks) {
      ctx.emit({
        type: 'chunk',
        command: ctx.command,
        chunk: resolved.runId,
        status: 'start',
        detail: `deep: ${formatCount(resolved.parts.length)} parts`,
      });

      const dir = join(tempRoot, resolved.runId);

      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dir, 0o700);

      // An unfinished chunk only wrote its first lines_done lines; the rest is `load_incomplete`,
      // not missing rows.
      const applied = row.status === 'loaded' ? Infinity : row.lines_done;
      // The chunk's rejected line numbers, ascending; `next` walks them alongside the lines so each
      // is compared once.
      const rejected = await rejectedLines(query, row.id);
      let next = 0;
      let lineNo = 0;

      try {
        for (const [i, part] of resolved.parts.entries()) {
          if (ctx.signal.aborted) throw msmError('interrupted', `${resolved.runId}: interrupted`);

          const path = partPath(dir, i);

          // The same gate load applies: bytes and sha256 must equal the manifest's before a line is
          // trusted.
          await withRetry(ctx, { source: 's3', name: `downloadPart ${part.name}` }, () =>
            downloadPart(run.store, part, path, ctx.config.minFreeDiskMb)
          );

          for await (const line of readGzipLines(createReadStream(path))) {
            lineNo += 1;

            while (next < rejected.length && (rejected[next] as number) < lineNo) next += 1;

            if (lineNo > applied || rejected[next] === lineNo) continue;

            const k = keyOf(line, mapping, table);

            if (k === null) continue;

            if ([...k].length > keyLedgerKey.maxChars) {
              throw msmError(
                'config',
                `${table.name}.${mapping.key.column}: line ${formatCount(lineNo)} ` +
                  `of ${resolved.runId} has a key of ${formatCount([...k].length)} ` +
                  `characters; keys over ${keyLedgerKey.maxChars} cannot be ` +
                  'deep-checked (the id table would truncate and merge them)',
                { fatal: true }
              );
            }

            pending.push([k]);
            docs += 1;

            if (pending.length >= insertRows) await flush();
          }

          await rm(path, { force: true });
          done += 1;

          ctx.emit({
            type: 'chunk',
            command: ctx.command,
            chunk: resolved.runId,
            status: 'part',
            detail: part.name,
          });

          ctx.emit({ type: 'progress', command: ctx.command, done, total, docs });
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }

    await flush();

    distinct = toSafeNumber(
      (await query(`SELECT COUNT(*) AS c FROM ${idsTable}`))[0]?.c,
      'deep distinct ids'
    );

    const antiJoin =
      `FROM ${idsTable} i LEFT JOIN ${t} ON ${t}.${key} = ${expr.toKey('i.`id`')} ` +
      `WHERE ${t}.${key} IS NULL`;

    const missing = toSafeNumber(
      (await query(`SELECT COUNT(*) AS c ${antiJoin}`))[0]?.c,
      'deep missing rows'
    );

    if (missing > 0) {
      const examples = (
        await query(`SELECT i.\`id\` AS id ${antiJoin} ORDER BY i.\`id\` LIMIT ${driftSample}`)
      ).map(r => String(r.id));

      drifts.push({
        table: table.name,
        kind: 'missing_rows',
        chunk: null,
        expected: distinct,
        actual: distinct - missing,
        detail:
          `${formatCount(missing)} ids in the archived parts have no ` +
          `row${missing > driftSample ? `; first ${driftSample}` : ''}: ` +
          `${examples.join(', ')}`,
      });
    }

    if (whole) {
      const notExists =
        `FROM ${t} WHERE ${t}.${key} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ` +
        `${idsTable} i WHERE i.\`id\` = ${expr.toText(`${t}.${key}`)})`;

      const unknown = toSafeNumber(
        (await query(`SELECT COUNT(*) AS c ${notExists}`))[0]?.c,
        'deep unknown rows'
      );

      if (unknown > 0) {
        const examples = (
          await query(
            `SELECT ${t}.${key} AS k ${notExists} ORDER BY ${t}.${key} LIMIT ${driftSample}`
          )
        ).map(r => String(r.k));

        drifts.push({
          table: table.name,
          kind: 'unknown_rows',
          chunk: null,
          expected: 0,
          actual: unknown,
          detail:
            `${formatCount(unknown)} keyed rows carry a key no part of any loaded ` +
            `batch holds${unknown > driftSample ? `; first ${driftSample}` : ''}: ` +
            `${examples.join(', ')}`,
        });
      }
    }
  } finally {
    await query(`DROP TEMPORARY TABLE IF EXISTS ${idsTable}`).catch(() => undefined);
    conn.release();
  }

  return { drifts, distinct };
}
