# Use case: an audit log into the table it never left

The application keeps an `audit_log_entries` table in MySQL. Years of older entries live in a MongoDB collection `audit_log` that is about to be retired. The goal: every archived entry becomes a row in that table, next to the rows the application writes itself, with no schema change and no way to tell the two apart in queries.

## The table

The application's own DDL, untouched. Two columns were added by the application team before the import: a nullable UNIQUE `source_mongo_id` beside the `AUTO_INCREMENT` id, and `backfill_run_id`.

```sql
CREATE TABLE `audit_log_entries` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `actor_id` varchar(255) NOT NULL,
  `description` text NOT NULL,
  `data` json DEFAULT NULL,
  `ip_address` varchar(45) DEFAULT NULL,
  `location` json DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT NULL,
  `updated_at` timestamp NULL DEFAULT NULL,
  `source_mongo_id` char(24) DEFAULT NULL,
  `backfill_run_id` varchar(64) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_ale_source_mongo_id` (`source_mongo_id`),
  KEY `idx_ale_actor_id` (`actor_id`),
  KEY `idx_ale_created_at` (`created_at`),
  KEY `idx_actor_id_created_at` (`actor_id`, `created_at`),
  KEY `idx_ale_actor_desc_created_id` (`actor_id`, `description`(100), `created_at`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

- Live rows keep `source_mongo_id` NULL; imported rows carry the Mongo `_id` there and dedupe on it, so a reload or a delta never duplicates an entry.
- `backfill_run_id` records which load wrote the row last.

## The mapping

[`examples/audit_log.mapping.json`](../examples/audit_log.mapping.json): the key comes from `_id`, two string columns get `""` when missing (the table says `NOT NULL`), `data` and `location` stay JSON with their Extended JSON wrappers, and the two timestamps are written as Manila wall-clock strings, truncated to seconds, exactly as the application writes them.

```json
{
  "collection": "audit_log", "table": "audit_log_entries", "key": { "column": "source_mongo_id", "cast": "objectId" },
  "runIdColumn": "backfill_run_id", "onCastError": "reject",
  "columns": [
    { "column": "actor_id", "source": "actor_id", "cast": "string", "default": "" },
    { "column": "description", "source": "description", "cast": "string", "default": "" },
    { "column": "data", "source": "data", "cast": "json" },
    { "column": "ip_address", "source": "ip_address", "cast": "string" },
    { "column": "location", "source": "location", "cast": "json" },
    { "column": "created_at", "source": "created_at", "cast": "datetime", "fsp": 0, "timezone": "Asia/Manila" },
    { "column": "updated_at", "source": "updated_at", "cast": "datetime", "fsp": 0, "timezone": "Asia/Manila" }
  ]
}
```

- `created_at` `{"$date":{"$numberLong":"1772409601527"}}` (2026-03-02T00:00:01.527Z) is written `'2026-03-02 08:00:01'`.
- The columns are `TIMESTAMP`, so MySQL reads that string in the session time zone. `mysql.sessionTimeZone` (default `+00:00`) must equal the application's connection `time_zone`; `load` warns whenever the cast zone's offset and the session zone differ, naming both, so the pair is checked once (the transcript below runs with the default session zone, hence the warnings).

## The run

The config lists `{ "name": "audit_log", "strategy": "timestamp-window", "field": "created_at", "window": "day", "rest": "export", "mapping": "mappings/audit_log.mapping.json" }`. `rest: export` catches the entries without a `created_at` in every full batch. The transcripts below are the built CLI's real output on the end-to-end twin (`test/e2e`: 300 entries over three days, one of them without `created_at`), trimmed to one chunk's lines where the others repeat; events go to stderr, the summary table and the `next:` line to stdout.

```console
$ mongo-s3-mysql --yes export --batch-id app-archive-full-2026-10 --cutoff 2026-03-05T00:00:00Z
starting full batch app-archive-full-2026-10, cutoff 2026-03-05T00:00:00.000Z
warning: audit_log: 1 documents have no BSON date in created_at and are in no window (the rest chunk exports them)
[app-archive-full-2026-10-audit_log-timestamp-window-20260302T000000Z-20260303T000000Z] start
[app-archive-full-2026-10-audit_log-timestamp-window-20260302T000000Z-20260303T000000Z] part part-000001.jsonl.gz 100 lines, 0.0 MB
[app-archive-full-2026-10-audit_log-timestamp-window-20260302T000000Z-20260303T000000Z] done 100 docs, 0.0 MB (0.1s)
progress 2/4 chunks, 200 docs
[app-archive-full-2026-10-audit_log-full-collection-rest] start
[app-archive-full-2026-10-audit_log-full-collection-rest] part part-000001.jsonl.gz 1 lines, 0.0 MB
[app-archive-full-2026-10-audit_log-full-collection-rest] done 1 docs, 0.0 MB (0.1s)
progress 4/4 chunks, 300 docs
batch app-archive-full-2026-10 complete: 4 of 4 chunks committed, 300 docs this run
┌─────────┬─────────────┬─────────┬──────┬─────────┬────────┬──────┐
│ (index) │ collection  │ planned │ done │ flagged │ failed │ docs │
├─────────┼─────────────┼─────────┼──────┼─────────┼────────┼──────┤
│ 0       │ 'audit_log' │ 4       │ 4    │ 0       │ 0      │ 300  │
└─────────┴─────────────┴─────────┴──────┴─────────┴────────┴──────┘
next: mongo-s3-mysql verify --batch-id app-archive-full-2026-10
```

```console
$ mongo-s3-mysql --yes verify --batch-id app-archive-full-2026-10
[app-archive-full-2026-10-audit_log-full-collection-rest] start
[app-archive-full-2026-10-audit_log-full-collection-rest] done 1 lines (0.0s)
progress 1/4 chunks, 1 docs
[app-archive-full-2026-10-audit_log-timestamp-window-20260302T000000Z-20260303T000000Z] done 100 lines (0.0s)
progress 4/4 chunks, 300 docs
┌─────────┬─────────────┬─────────┬────┬─────────┬────────────┬───────┐
│ (index) │ collection  │ checked │ ok │ damaged │ unreadable │ lines │
├─────────┼─────────────┼─────────┼────┼─────────┼────────────┼───────┤
│ 0       │ 'audit_log' │ 4       │ 4  │ 0       │ 0          │ 300   │
└─────────┴─────────────┴─────────┴────┴─────────┴────────────┴───────┘
next: mongo-s3-mysql infer, then mongo-s3-mysql load
```

```console
$ mongo-s3-mysql --yes -C audit_log load --batch-id app-archive-full-2026-10
warning: audit_log: audit_log_entries.created_at is TIMESTAMP: the cast writes Asia/Manila wall-clock values (currently +08:00) and mysql.sessionTimeZone is +00:00, so MySQL reads them in another zone; set both to the application's connection time_zone
warning: audit_log: audit_log_entries.updated_at is TIMESTAMP: the cast writes Asia/Manila wall-clock values (currently +08:00) and mysql.sessionTimeZone is +00:00, so MySQL reads them in another zone; set both to the application's connection time_zone
batch app-archive-full-2026-10: loading 4 chunks
[app-archive-full-2026-10-audit_log-timestamp-window-20260302T000000Z-20260303T000000Z] start
[app-archive-full-2026-10-audit_log-timestamp-window-20260302T000000Z-20260303T000000Z] part part-000001.jsonl.gz 100 lines read
[app-archive-full-2026-10-audit_log-timestamp-window-20260302T000000Z-20260303T000000Z] done 100 lines: 100 inserted, 0 updated, 0 rejected (0.0s)
progress 3/4 chunks, 200 docs
load load-20261101T020000Z: 4 of 4 chunks loaded, 300 documents this run, 0 skipped
┌─────────┬─────────────────────┬────────┬──────────┬─────────┬────────────┬──────────┐
│ (index) │ table               │ chunks │ inserted │ updated │ duplicates │ rejected │
├─────────┼─────────────────────┼────────┼──────────┼─────────┼────────────┼──────────┤
│ 0       │ 'audit_log_entries' │ 4      │ 300      │ 0       │ 0          │ 0        │
└─────────┴─────────────────────┴────────┴──────────┴─────────┴────────────┴──────────┘
next: mongo-s3-mysql -C audit_log reconcile
```

```console
$ mongo-s3-mysql --yes -C audit_log reconcile --batch-id app-archive-full-2026-10
no drift in 1 tables
┌─────────┬─────────────────────┬────────┬───────┬───────────┬─────────┬──────────┬────────────┬───────┐
│ (index) │ table               │ chunks │ keyed │ untracked │ foreign │ rejected │ castErrors │ deep  │
├─────────┼─────────────────────┼────────┼───────┼───────────┼─────────┼──────────┼────────────┼───────┤
│ 0       │ 'audit_log_entries' │ 4      │ 300   │ 0         │ 0       │ 0        │ 0          │ false │
└─────────┴─────────────────────┴────────┴───────┴───────────┴─────────┴──────────┴────────────┴───────┘
next: mongo-s3-mysql -C audit_log reconcile --deep proves coverage row by row
```

- The export warns about the one entry without a `created_at`: it is in no window, and the rest chunk (`full-collection-rest`, 1 doc) carries it. The batch manifest records it as `out_of_range.untyped`.
- `load` refuses to start on a shape problem: a missing column, a second UNIQUE key the upsert could hit, a `NOT NULL` column the mapping cannot fill ([mapping](mapping.md#shape-check)). Here the only output before the chunks is the `TIMESTAMP` warning, once per column.
- Every command above runs with `--yes`: on a TTY it would otherwise print its `... [y/N]` question on stderr first, and without a TTY it refuses with `not a TTY: pass --yes to confirm`. The `next:` hints repeat the `-c` and `-C` flags the run was given, so they can be pasted as they are.
- An entry whose `_id` is not an ObjectId lands in `_msm_load_rejects` with its line text; the count is in the load summary (`rejected`) and in every `reconcile` run.

## Keeping it current until the switch

- The collection keeps receiving writes until the application switches. A delta every night, `export --since last` then `verify`, `load`, `reconcile`, carries the inserts over; `created_at` is a creation time, so in-place updates to old entries are not caught ([limitations](limitations.md)).
- Nightly deltas never carry the rest documents: `rest: export` applies to full batches, and a delta plans the rest chunk only with `--include-rest`. Entries written without a `created_at` after the full batch wait for the final step.
- Rows the application deletes afterwards show up as `table_count` drift on every `reconcile`; `--ignore table_count,missing_rows` accepts that once it is intended.

## The final step

The default cutoff is `now` minus 60 minutes, floored to the hour, so an ordinary last delta leaves up to about two hours of entries in no window. Once the application has stopped writing to the collection:

```bash
mongo-s3-mysql --yes export --since last --include-rest --cutoff 2026-11-01T00:00:00Z   # an hour boundary at or after the switch, not in the future
mongo-s3-mysql --yes verify --batch-id <that batch>
mongo-s3-mysql --yes -C audit_log load --batch-id <that batch>
mongo-s3-mysql --yes -C audit_log reconcile --batch-id <that batch> --deep
```

- `--include-rest` makes this delta carry the entries without a `created_at`; `--cutoff` at the switch (or after waiting `safetyLagMinutes` plus an hour) makes its windows reach the last write.
- Check the batch manifest: `out_of_range.after_cutoff` must be 0, and the rest chunk (`...-full-collection-rest`) must be committed with a `exported_count` equal to `out_of_range.untyped`. `untyped` counts every entry without a `created_at`, archived or not (the one from the full batch stays in it), so it is never 0 here; the rest chunk is what carries those entries.
- `reconcile --deep` reads every part once and proves row by row that each archived `_id` is in the table. It only checks ids that are in the parts, which is why the two steps above come first.
