# Reconcile

`reconcile` is the read-only proof that the MySQL tables hold what the archive holds. It compares three things that were written at different times by different commands: the chunk and batch manifests in S3 (written by `export`, or by the original exporter), the load ledger `_msm_load_chunks` (written by `load`), and the target tables themselves. It never writes to S3 or MySQL; `--deep` creates one temporary table on its own connection and drops it, and takes the `reconcile` lock in `stateDir` while it downloads. An interrupt returns the drifts found so far with exit 130 or 143.

```bash
mongo-s3-mysql reconcile                              # every batch the ledger knows, every mapped collection
mongo-s3-mysql reconcile --batch-id <id>,<id>         # only these batches
mongo-s3-mysql reconcile --deep                       # re-read the parts and prove coverage row by row (asks first)
mongo-s3-mysql reconcile --show-ok                    # list the chunks without drift too
mongo-s3-mysql reconcile --ignore table_count,missing_rows
```

Exit 0 means no drift; exit 4 means at least one drift whose kind is not in `--ignore` ([exit codes](operations.md#exit-codes)). Drifts go to stderr as events and to stdout as a table (or inside the JSON document with `--json`).

## What is selected

| Scope | Rule |
| --- | --- |
| collections | `-C a,b`, else the configured ones, else every collection under the manifests prefix. A collection without a mapping file is skipped with a warning while others are checked; a run in which no selected collection has a mapping is a config error (`nothing reconciled`), and so is a `-C` name without a mapping file or with no chunk manifest and no ledger row, so a typo cannot pass as "no drift". A `mapping` path in the config that does not exist is an error |
| table | the mapping's `table`; it must exist (reconcile creates nothing) |
| batches | `--batch-id`, else every `batch_id` in the collection's ledger rows, else (nothing loaded yet) every batch manifest in the archive. A `--batch-id` that no batch manifest, chunk manifest or ledger row knows is a config error, so a typo cannot pass as "no drift" |
| chunks | every chunk manifest of the selected batches, matched to the ledger rows of the same collection by chunk run id |

Only the selected batches' ledger rows take part, so `--batch-id` narrows the proof to those batches: keyed rows that other batches wrote count as `foreign`, not as drift. Two collections that load one table (`audit-log` and `audit.log` both derive `audit_log`, say) are each matched to their own ledger rows for the record checks; the table-side proofs and the summary row run once per table, over both. They must share the key column.

## Drift kinds

Every row below is a drift. The run ends with exit 4 unless the drift's kind is listed in `--ignore`; ignored drifts are still printed, marked `(ignored)`.

| Kind | Condition | Source |
| --- | --- | --- |
| `not_loaded` | a chunk manifest with no ledger row; the detail says when the export flagged it (`counts_match: false`, which `load` refuses without `--allow-mismatch`) | records |
| `load_incomplete` | the ledger row's `status` is `loading` or `failed`; the detail shows the resume point and the last error | records |
| `manifest_changed` | the ledger's `manifest_sha256` differs from the sha256 of the manifest object now, or the manifest object is gone | records |
| `line_count` | `rows_inserted + rows_updated + duplicates_skipped + rows_rejected` or `lines_done` differs from `exported_count` | records |
| `batch_incomplete` | the batch manifest has `failed_chunks > 0`, `completed_at` null, or a tool `status` other than `complete`; a chunk that never finished has no manifest, so it is not listed as `not_loaded` | records |
| `table_count` | key ledger: `expected` = distinct keys the selected chunks wrote (`_msm_load_keys`), `actual` = those with a row now; a drift when `actual < expected`, naming up to 20 missing keys with their chunk | MySQL |
| `chunk_count` | chunk column: rows tagged with a chunk's ledger id exceed that chunk's `rows_inserted + rows_updated`, or (with the key ledger) a tagged row carries a key that chunk never wrote | MySQL |
| `orphan_chunk` | chunk column: a non-NULL value that is no ledger row at all | MySQL |
| `missing_rows` | `--deep`: an `_id` in the selected batches' parts has no row (up to 20 named) | parts |
| `unknown_rows` | `--deep`, whole-ledger selection only: a keyed row whose key is in no part of any loaded batch | parts |
| `deep_distinct` | `--deep` with the key ledger: the distinct ids read from the parts differ from the key ledger's count for the same chunks | parts |

The first five come from the records alone (`chunkDrift`, a pure function over manifests and ledger rows); the next three from SQL against the live table (`tableCheck`); the last three from reading the archive (`deepCheck`).

## Informational lines

These are reported but are not drift:

- `N lines rejected at load; reasons: ...`: lines in `_msm_load_rejects` (a bad `_id`, a cast error under `onCastError: reject`), with the most frequent reasons.
- `N columns nulled by cast errors`: `cast_errors` under `onCastError: null`.
- `N chunks were loaded with --allow-mismatch`.
- `N rows have no key`: `untracked` rows, where the key column is NULL. Those are the application's own rows in a shared table; the tool never touches them.
- `N keyed rows are outside the selected batches`: `foreign` = `COUNT(key)` minus the keys the selection accounts for. Other batches, or rows an earlier importer wrote.

The summary table on stdout has one row per table: `chunks` (selected ledger rows), `keyed`, `untracked`, `foreign`, `rejected`, `castErrors`, `deep`.

## How coverage is proven

Without `--deep`, nothing is read from S3 but the manifests. The table side is three or four statements per table:

```sql
SELECT COUNT(`key`), COUNT(*) - COUNT(`key`) FROM `t`;                          -- keyed, untracked
SELECT COUNT(DISTINCT `key_value`) FROM `_msm_load_keys` WHERE `chunk_id` IN (...);  -- expected
SELECT COUNT(DISTINCT k.`key_value`) FROM `_msm_load_keys` k
  LEFT JOIN `t` ON `t`.`key` = CONVERT(k.`key_value` USING <key charset>) COLLATE <key collation>
  WHERE k.`chunk_id` IN (...) AND `t`.`key` IS NULL;                               -- missing
SELECT `chunk`, COUNT(*) FROM `t` WHERE `chunk` IS NOT NULL GROUP BY `chunk`;        -- with chunkColumn
```

The conversion sits on the ledger side of the join so the UNIQUE index on the key column is used; integer keys (`cast: bigint`) use `CAST` instead. The chunk GROUP BY uses the index infer's DDL puts on the chunk column.

The key ledger costs about 110 bytes per ObjectId document. Without it, coverage is unproven:

- With `load.keyLedger: false` there is no `table_count` and no `deep_distinct`; the run warns `table coverage unproven; run --deep`, and `foreign` is only an estimate from the `rows_inserted` counters.
- A chunk loaded while the ledger was off and checked after it was turned on has no key rows (so does every chunk when `_msm_load_keys` does not exist yet), and one loaded partly with the ledger off has fewer key rows than `rows_inserted` (keys are written in the same transaction as the counters, and rows inserted within one chunk are distinct keys): either is left out of both proofs, named in a `coverage unproven for N chunks` warning, and `deep_distinct` is skipped for its table.

## The deep check

`--deep` reads every part of the selected chunks that have a ledger row, once, after a prompt that names the bytes, parts and chunks involved (`--yes` answers it). Each part is downloaded to `tempDir`, its size and sha256 checked against the manifest before a line is trusted, and the key-cast `_id` of every line is inserted into a temporary table on one connection:

```sql
CREATE TEMPORARY TABLE `_msm_ids` (`id` VARCHAR(760) COLLATE utf8mb4_0900_bin PRIMARY KEY);
INSERT IGNORE INTO `_msm_ids` (`id`) VALUES ...;        -- 1,000 ids per statement
SELECT COUNT(*) FROM `_msm_ids`;                          -- distinct ids
SELECT COUNT(*) FROM `_msm_ids` i LEFT JOIN `t` ON `t`.`key` = CONVERT(i.`id` ...) WHERE `t`.`key` IS NULL;   -- missing_rows
SELECT COUNT(*) FROM `t` WHERE `t`.`key` IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM `_msm_ids` i WHERE i.`id` = CONVERT(`t`.`key` ...));                           -- unknown_rows, whole selection only
```

What the deep check skips and refuses:

- Lines `load` rejected: the ones `_msm_load_rejects` records for the chunk (a cast error, a NOT NULL column without a default), and the ones whose `_id` the key cast refuses. They have no row by design and are counted under the rejected lines.
- Lines past an unfinished chunk's `lines_done`, which `load_incomplete` already reports. The rejected line numbers are read per chunk as it is reached, so memory stays bounded by one chunk's rejects.
- A key longer than 760 characters ends the check with a config error naming the line: the id table is `VARCHAR(760)`, and a truncated key would merge with its neighbours into false `missing_rows`. With `load.keyLedger` on the shape check refuses such a key column before any load; with it off, `--deep` is where it surfaces.
- A part whose bytes or sha256 differ from the manifest ends the check with a `sha256` error; one whose `s3_uri` is outside the chunk's raw prefix is a `record` error and is never fetched. Run `verify` to find out what happened to it.
- The temporary table is dropped and the files are removed whether the check passes or fails.

## Repair

| Drift | What to do |
| --- | --- |
| `not_loaded`, `load_incomplete` | `load --batch-id <batch>`; the ledger resumes from `lines_done` |
| `manifest_changed`, `line_count` | `load --reload --batch-id <batch>` resets the chunk and applies the current manifest |
| `table_count`, `missing_rows` | `load --reload --batch-id <affected batch>,<every newer loaded batch>`: later batches must replay too, so a document updated in a later batch keeps its latest version (the load order guard insists on it). Afterwards `actual = expected` and the run exits 0 |
| `batch_incomplete` | for a batch this tool wrote: `export --batch-id <batch>` while the source still exists; the missing chunks are written at the same keys, then `verify` and `load`. A batch from another exporter cannot be resumed: export the collections again under a new batch id |
| `chunk_count`, `orphan_chunk`, `unknown_rows` | rows written outside the tool or with another mapping; inspect them, then `load --reload` or `--ignore` |
| `deep_distinct` | the key ledger and the parts disagree; `load --reload` rewrites both |

Rows deleted on purpose after the load are reported every time; `--ignore table_count,missing_rows` accepts that state. Keep the ignore list in the command that runs on a schedule, not in the config, so it is visible where the exit code is read.

## What reconcile cannot see

- A document updated in place at the source after its window was exported and before the source was retired, with no later re-export: `_id` and every count are unchanged, so nothing detects it. Deltas catch inserts by their window field only ([how it works](how-it-works.md)).
- Edits to the MySQL rows after the load: a changed column value leaves the key and the counts intact.
- Deletes at the source: the archive and the table keep the document.
- Child table rows: only the parent table is reconciled.
- A chunk that was loaded with another mapping and never reloaded: `load` reports it when it skips the chunk; reconcile compares only counts and keys.
