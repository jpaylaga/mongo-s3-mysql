# How it works

## Pipeline

```
inventory   read Mongo, suggest a strategy per collection, write it into the config
export      Mongo -> gzipped Extended JSON parts + manifests in S3 (one batch at a time)
verify      read every chunk not yet verified for its current manifest (--all: every chunk) and check sizes, checksums, line counts
infer       sample the parts and write a mapping file per collection
load        S3 -> your MySQL tables, upserting on the key column, one batch transaction at a time
reconcile   prove the tables hold what the archive holds
```

`export`, `verify`, `load` and `reconcile --deep` take a lock in `stateDir` (one per command), so two exports or two loads cannot run against the same state directory at once; `inventory`, `infer` and a plain `reconcile` write nothing shared and take none. Secrets come only from the environment: `MSM_MONGO_URI` for Mongo, `MSM_MYSQL_PASSWORD` for MySQL, the default credential chain for AWS.

## Layout in S3

The tool writes and reads exactly one layout: the one a production exporter wrote before this tool existed, so archives from either source load unchanged. `{p}` is `s3.prefix` plus `/`, `{P}` the ordered `key=value` partition segments from the config, `{c}` the collection, `{r}` a chunk run id, `{b}` a batch id.

```
{p}raw/{P}/collection={c}/source_year=2026/source_month=03/source_day=02/source_hour=00/run_id={r}/part-000001.jsonl.gz
{p}raw/{P}/collection={c}/.../run_id={r}/part-000001.jsonl.gz.sha256       "<sha256>  part-000001.jsonl.gz"
{p}manifests/{P}/collection={c}/run_id={r}.json                               chunk manifest (the commit record)
{p}manifests/{P}/run_id={b}.json                                              batch manifest
{p}validation/{P}/collection={c}/run_id={r}/counts.json
{p}validation/{P}/collection={c}/run_id={r}/parse-check.json
```

Window chunks put the UTC start of their window into the `source_*` segments; whole-collection and rest chunks use `all` in all four. Each line of a part is one document in canonical Extended JSON v2 (`{"$oid": ...}`, `{"$numberLong": ...}`, `{"$date": {"$numberLong": ...}}`), so BSON types survive the round trip and the load can cast from the real type.

## Batches, chunks and modes

An export invocation works on one **batch**: `<batchPrefix>-full-<start>` or `<batchPrefix>-delta-<start>`, or any id you pass with `--batch-id`. A batch is a set of **chunks**, one per collection and window. The batch manifest freezes the plan at the first run, so a fixed `--batch-id` starts the batch once and every later run with the same id resumes it.

| Strategy | Chunk | How it is read |
| --- | --- | --- |
| `timestamp-window` | `[start, end)` on an indexed date field, hour or day grid in UTC | one unsorted cursor hinted with the field's index |
| `objectid-window` | the same grid on ObjectId time | keyset pages over `_id` |
| `full-collection` | the whole collection | keyset pages over `_id`, every id type in BSON order |
| rest (tool addition, windowed collections) | everything no window can see | keyset pages with the rest filter ANDed into each page |
| `manifest-only` | an empty collection | nothing; the manifest records the empty count |

Run ids name all of that: `{b}-{c}-timestamp-window-20260302T000000Z-20260303T000000Z`, `{b}-{c}-full-collection-full`, `{b}-{c}-full-collection-rest`, `{b}-{c}-manifest-only-full`.

## The commit record

A chunk is exported if and only if its manifest exists with `counts_match: true`. The order of writes inside one chunk is fixed: every part and its sidecar, then `counts.json` and `parse-check.json`, then the manifest. A crash anywhere before the manifest leaves raw objects nobody references; the next run rewrites the chunk at the same deterministic keys. The tool never deletes an S3 object, and never overwrites a manifest whose counts matched.

Each chunk is counted twice with the same filter and index hint: `countDocuments` before the read and again after it. The manifest holds both (`source_count`, `source_count_after`) next to `exported_count`, and `filter.hint` records the index the count ran under (null when the server refused the planned one). When the three differ, the chunk is tried up to `export.chunkAttempts` times in all and then written **flagged** (`counts_match: false`): `load` refuses a flagged chunk without `--allow-mismatch`, and the next `export --batch-id` run re-exports it (a flagged chunk is never cached as done).

The local file `<stateDir>/export/<batchId>/completed.jsonl` caches the committed manifests (with their key and bucket) so a resume on the same host skips their S3 reads. It is only a cache: a resume always lists the manifests, and a cached chunk whose manifest the listing does not return is planned again. Every collection of the frozen plan is planned on each resume, so the batch manifest's tally covers the batch; `-C` only chooses which pending chunks run.

## Keyset versus cursor

A field window is read with one unsorted cursor under the field index. Without a sort there is no way to resume a cursor that died halfway, so any error ends the attempt and the window restarts; use `window: hour` for busy collections.

Everything else walks `_id` in pages (`export.keysetPageDocs`), sorted and hinted `_id_`. The `_id` space is split into 8 type brackets in BSON order (numbers, strings, objects, binary, ObjectId, booleans, dates, timestamps); each bracket opens with `$gte: <lowest value of the type>` and pages with `$gt: <last id>`. A failed page is retried from the last id, so a failover costs one page, not the chunk. Ids of other types (null, MinKey, MaxKey, NaN, code, DBPointer) are counted but never walked, both by a `full-collection` chunk (its count is `{}`) and by a windowed collection's rest chunk (its filter names those types), so such a chunk fails its count check instead of silently losing documents.

## Rest and out of range

Windows cover documents whose window value is a date (or an ObjectId) between the collection's start and the batch cutoff. Three kinds of document fall outside:

- the window field is missing or not a date (or `_id` is not an ObjectId);
- the value is at or after the cutoff (future dates, fast clocks);
- the value is before an explicit `start`.

`planChunks` counts all three as `out_of_range` in the batch manifest (`before_start`, `after_cutoff`, `untyped`) and warns when they are not zero. The **rest chunk** exports all three kinds as one keyset walk with a filter:

- `rest: export` plans it in every full batch; `rest: auto` (the default) plans it in full batches when the collection has at most 1,000,000 documents; `rest: skip` never does.
- Deltas never plan it unless `--include-rest` is passed, which plans it in any batch.
- Its after-cutoff term leaves a gap for live writes: `[cutoff, startedAt)` stays in (frozen in the plan), then `[startedAt, max(startedAt, attemptStart) + 1 day)` stays out (a resume two days after the batch began leaves out three days), then far-future values are in again. Without the gap every insert on a live collection would land in the rest filter and flag the chunk on every attempt; the next delta's windows cover those writes anyway. The manifest's `filter.query` records the term the attempt used.
- A windowed collection in which no document has a window-typed value plans nothing without the rest chunk, so the export refuses instead of committing an empty batch; pass `--include-rest` or fix the strategy.
- The filter is index-bounded for ObjectId windows and a scan for field windows, so expect it to be slow on large collections.

The cutoff defaults to `now - safetyLagMinutes` floored to the hour, so documents still being written by slow clients are not caught half-way.

## Deltas and what they miss

`export --since <iso>` or `--since last` runs a delta:

- Windowed collections are exported from `since` to the cutoff; `full-collection` ones whole again (`backup_mode: delta-windowed-with-full-small-collections`, the production exporter's name for the same thing).
- `--since last` is resolved per collection: the newest complete batch that covers that collection, its `cutoff_utc` minus `export.deltaOverlapMinutes`. A batch with a frozen plan covers what the plan names; a batch from another exporter (no plan) covers the collections it holds a chunk manifest for, or that its `collection_start_utc` names, so a collection added to the config later is refused rather than started from a cutoff that skips its history.
- The overlap means the two batches share a window; `load` resolves it (last writer wins, in cutoff order).
- A collection no complete batch covers has no safe delta start, and the run refuses it.
- On an existing batch `--since last` is a no-op (the frozen plan wins); an explicit `--since` or `--cutoff` must equal the frozen value.
- The cutoff may not be in the future; one inside the safety lag warns.
- Instants on the command line carry an offset and no fraction (`2026-10-12T00:00:00Z`).

A delta catches inserts, and updates whenever the window field is an update timestamp. It misses:

- deletes (nothing propagates a delete; see `docs/reconcile.md`);
- updates to documents outside the re-exported windows;
- back-dated writes whose window value is older than `since`;
- rest documents, unless `--include-rest` is passed;
- a `full-collection` collection written during its walk is flagged in every delta, because its before and after counts differ. Export it in a quiet moment, window it, or load it with `--allow-mismatch`.

## Signals and exit codes

The first SIGINT or SIGTERM stops every chunk between two documents (an in-flight MongoDB call is never cancelled, so a keyset page, a count or a cursor batch runs to its end first, up to `mongo.maxTimeMs`), abandons the in-flight uploads (the SDK does not cancel a request already sent, so S3 may still store the part; it is overwritten on resume), rewrites the batch manifest as `interrupted` (or `complete`, when the signal landed after the last chunk committed) and releases the lock; a second signal exits at once. Either way the next `export --batch-id <id>` resumes from the committed manifests. Exit codes: 0 everything committed, 2 flagged or failed chunks remain, 1 a fatal error (config, permission, lock), 130 after SIGINT, 143 after SIGTERM. `docs/operations.md` has the triage table.
