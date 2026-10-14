import type { Pool } from 'mysql2/promise';
import isNoSuchTable from '#mysql/isNoSuchTable';
import quoteId from '#mysql/quoteId';
import toSafeNumber from '#mysql/toSafeNumber';
import driftSample from '#reconcile/driftSample';
import keyExpr from '#reconcile/keyExpr';
import formatCount from '#runtime/formatCount';
import type { Drift, LedgerRow, Mapping, TableCheckResult, TableInfo } from '#types';

type Row = Record<string, unknown>;

async function rows(pool: Pool, sql: string, params: unknown[] = []): Promise<Row[]> {
  const [result] = await pool.query(sql, params);

  return result as Row[];
}

/**
 * The ledger tables may be absent when nothing was ever loaded; that reads as "no evidence", not as
 * an error.
 */
async function rowsOrNone(pool: Pool, sql: string, params: unknown[] = []): Promise<Row[] | null> {
  try {
    return await rows(pool, sql, params);
  } catch (err) {
    if (isNoSuchTable(err)) return null;

    throw err;
  }
}

/**
 * Proves table coverage from MySQL alone: the key ledger says which keys the selected chunks wrote,
 * an anti-join says which of them have no row now; the chunk column, when the mapping has one,
 * bounds each chunk's tagged rows by what its ledger row says it wrote. A chunk that wrote rows but
 * has fewer key rows than rows inserted (loaded wholly or partly while `load.keyLedger` was off;
 * keys are written in the same transaction as the counters and rows inserted within one chunk are
 * distinct keys, so the two must agree) is left out of both proofs and reported as unproven; so is
 * every such chunk when `_msm_load_keys` does not exist at all. No part is read.
 */
export default async function tableCheck(
  pool: Pool,
  mapping: Mapping,
  table: TableInfo,
  selected: LedgerRow[],
  keyLedger: boolean
): Promise<TableCheckResult> {
  const t = quoteId(table.name);
  const key = quoteId(mapping.key.column);
  const expr = keyExpr(table.columns.get(mapping.key.column) ?? null, mapping.key.cast);
  const drifts: Drift[] = [];
  const byId = new Map(selected.map(row => [row.id, row]));
  const ids = [...byId.keys()];

  const [counts] = await rows(
    pool,
    `SELECT COUNT(${key}) AS keyed, COUNT(*) - COUNT(${key}) AS untracked FROM ${t}`
  );

  const keyed = toSafeNumber(counts?.keyed, `${table.name} keyed rows`);
  const untracked = toSafeNumber(counts?.untracked, `${table.name} untracked rows`);

  let expected: number | null = null;
  let actual: number | null = null;
  const unproven: string[] = [];
  const proven: number[] = [];

  if (keyLedger && ids.length > 0) {
    const perChunk = await rowsOrNone(
      pool,
      'SELECT `chunk_id`, COUNT(*) AS key_rows FROM `_msm_load_keys` WHERE ' +
        '`chunk_id` IN (?) GROUP BY `chunk_id`',
      [ids]
    );

    const keyRows = new Map(
      (perChunk ?? []).map(r => [
        toSafeNumber(r.chunk_id, 'chunk_id'),
        toSafeNumber(r.key_rows, 'key_rows'),
      ])
    );

    for (const row of selected) {
      const recorded = keyRows.get(row.id) ?? 0;
      const wrote = row.rows_inserted + row.rows_updated > 0;

      if (wrote && (recorded === 0 || recorded < row.rows_inserted))
        unproven.push(row.chunk_run_id);
      else if (perChunk !== null) proven.push(row.id);
    }

    if (perChunk !== null) {
      const [expectedRows] =
        proven.length === 0
          ? [{ expected: '0' }]
          : await rows(
              pool,
              'SELECT COUNT(DISTINCT `key_value`) AS expected FROM ' +
                '`_msm_load_keys` WHERE `chunk_id` IN (?)',
              [proven]
            );

      expected = toSafeNumber(expectedRows?.expected, `${table.name} expected keys`);

      let missing = 0;

      if (proven.length > 0) {
        const antiJoin =
          `FROM \`_msm_load_keys\` k LEFT JOIN ${t} ON ${t}.${key} = ` +
          `${expr.toKey('k.`key_value`')} WHERE k.\`chunk_id\` IN (?) AND ${t}.${key}` +
          ' IS NULL';

        const [missingRow] = await rows(
          pool,
          `SELECT COUNT(DISTINCT k.\`key_value\`) AS missing ${antiJoin}`,
          [proven]
        );

        missing = toSafeNumber(missingRow?.missing, `${table.name} missing keys`);

        if (missing > 0) {
          const examples = await rows(
            pool,
            `SELECT k.\`key_value\` AS key_value, MIN(k.\`chunk_id\`) AS chunk_id ` +
              `${antiJoin} GROUP BY k.\`key_value\` ORDER BY k.\`key_value\` LIMIT ` +
              `${driftSample}`,
            [proven]
          );

          const list = examples.map(r => {
            const ledgerRow = byId.get(toSafeNumber(r.chunk_id, 'chunk_id'));

            return (
              `${String(r.key_value)} ` +
              `(${ledgerRow?.chunk_run_id ?? `chunk ${String(r.chunk_id)}`})`
            );
          });

          drifts.push({
            table: table.name,
            kind: 'table_count',
            chunk: null,
            expected,
            actual: expected - missing,
            detail:
              `${formatCount(missing)} keys written by the selected chunks have no ` +
              `row${missing > driftSample ? `; first ${driftSample}` : ''}: ` +
              `${list.join(', ')}`,
          });
        }
      }

      actual = expected - missing;
    }
  }

  if (mapping.chunkColumn !== null) {
    const c = quoteId(mapping.chunkColumn);

    const groups = await rows(
      pool,
      `SELECT ${c} AS chunk_id, COUNT(*) AS tagged FROM ${t} WHERE ${c} IS NOT NULL GROUP BY ${c}`
    );

    const tagged = groups.map(g => ({
      id: toSafeNumber(g.chunk_id, `${table.name}.${mapping.chunkColumn}`),
      count: toSafeNumber(g.tagged, 'tagged rows'),
    }));

    const unknown = tagged.filter(g => !byId.has(g.id)).map(g => g.id);
    const known = new Set<number>();

    if (unknown.length > 0) {
      const existing = await rowsOrNone(
        pool,
        'SELECT `id` FROM `_msm_load_chunks` WHERE `target_table` = ? AND `id` IN (?)',
        [table.name, unknown]
      );

      for (const r of existing ?? []) known.add(toSafeNumber(r.id, 'ledger id'));
    }

    for (const g of tagged) {
      const row = byId.get(g.id);

      if (row === undefined) {
        // Another batch's chunk is not this run's concern; a value no ledger row ever had is.
        if (!known.has(g.id))
          drifts.push({
            table: table.name,
            kind: 'orphan_chunk',
            chunk: null,
            expected: null,
            actual: g.count,
            detail:
              `${formatCount(g.count)} rows tagged ${mapping.chunkColumn} = ${g.id}, ` +
              'which is no load ledger row',
          });

        continue;
      }

      const bound = row.rows_inserted + row.rows_updated;

      if (g.count > bound)
        drifts.push({
          table: table.name,
          kind: 'chunk_count',
          chunk: row.chunk_run_id,
          expected: bound,
          actual: g.count,
          detail:
            `${formatCount(g.count)} rows tagged with ledger id ${g.id}, but the ` +
            `chunk wrote ${formatCount(row.rows_inserted)} + ` +
            `${formatCount(row.rows_updated)} rows`,
        });
    }

    if (keyLedger && expected !== null && proven.length > 0) {
      const strays = await rows(
        pool,
        `SELECT ${t}.${c} AS chunk_id, COUNT(*) AS stray FROM ${t} LEFT JOIN ` +
          `\`_msm_load_keys\` k ON k.\`chunk_id\` = ${t}.${c} AND k.\`key_value\` = ` +
          `${expr.toText(`${t}.${key}`)}` +
          ` WHERE ${t}.${c} IN (?) AND k.\`chunk_id\` IS NULL GROUP BY ${t}.${c}`,
        [proven]
      );

      for (const s of strays) {
        const id = toSafeNumber(s.chunk_id, 'chunk_id');
        const count = toSafeNumber(s.stray, 'stray rows');

        drifts.push({
          table: table.name,
          kind: 'chunk_count',
          chunk: byId.get(id)?.chunk_run_id ?? null,
          expected: 0,
          actual: count,
          detail:
            `${formatCount(count)} rows tagged with ledger id ${id} carry keys that ` +
            'chunk never wrote',
        });
      }
    }
  }

  // Without the key ledger the inserted counters are the only estimate of what the selection
  // accounts for.
  const accounted =
    actual ??
    selected.filter(r => r.status === 'loaded').reduce((sum, r) => sum + r.rows_inserted, 0);

  return {
    drifts,
    keyed,
    untracked,
    foreign: Math.max(0, keyed - accounted),
    expected,
    actual,
    unproven,
  };
}
