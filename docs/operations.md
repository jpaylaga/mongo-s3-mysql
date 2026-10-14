# Operations

## Running a long export under systemd

Give the batch a fixed id: the first run starts it, every restart resumes it, and nothing has to parse the previous run's output.

```ini
# /etc/systemd/system/mongo-archive.service
[Unit]
Description=Archive MongoDB to S3
After=network-online.target

[Service]
Type=oneshot
User=archive
WorkingDirectory=/srv/mongo-archive
# The env file holds MSM_MONGO_URI and the AWS credentials (or the box has an instance profile).
EnvironmentFile=/etc/mongo-archive/env
ExecStart=/usr/bin/mongo-s3-mysql --yes export --batch-id app-archive-full-2026-10
Restart=on-failure
RestartSec=60
TimeoutStopSec=600
KillSignal=SIGTERM
```

- `--yes` answers the prompt; without a TTY the command refuses to run otherwise. `--log-format json` turns the stderr events into JSON lines, which journald and log shippers index as fields.
- `Restart=on-failure` restarts the unit on exit code 2 (flagged or failed chunks remain) and 1; exit 0 ends it. Set `RestartSec` high enough for a failover to finish.
- `TimeoutStopSec` is bounded by the longest single MongoDB round trip: the first SIGTERM abandons the upload in flight at once (S3 may still finish storing it; the part is overwritten when the chunk runs again) and stops between documents, but an in-flight MongoDB call (a keyset page, a count, a cursor batch; a rest page on a large collection can scan far) is never cancelled and runs to its end, up to `mongo.maxTimeMs` (30 minutes by default). Size `TimeoutStopSec` from that, or lower `mongo.maxTimeMs`; the batch manifest rewrite and lock release need a few seconds more. A SIGKILL leaves the batch manifest `running` until the next resume rewrites it.
- A delta after the full batch: `export --since last --batch-id app-archive-delta-2026-11`. The same line restarts the unit after an exit 2 or a crash: on an existing batch `--since last` is a no-op (an info line says so) and an explicit `--since` or `--cutoff` is accepted when it equals the frozen plan, so the restart loop never fails on the flags that started the batch.

Do not run two exports with the same `stateDir` at once: the second one fails with `export already running (pid P on H); pass --force-unlock if it is gone`. A lock left by a crashed process on the same host is taken over, also after a container restart that reused the pid (on Linux the lock records the process start time and boot id, so a live pid that is another process does not block); one from another host needs `--force-unlock`. The holder touches its lock every 30 seconds, and every takeover waits for that heartbeat to go stale: a pid that looks gone or replaced from here may be a live holder in another PID namespace on the same hostname (a host-network container beside a host cron, two containers in one pod), so such a lock is taken over only once untouched for 90 seconds. A lock that names this process's own pid but is not held by it (a restart, or a sibling container that is also pid 1 and shares the hostname and the state directory) is refused until untouched for five minutes; so after a restart the first run within those minutes fails with `already running`, and sibling containers should not share a `stateDir`. `tempDir` may be shared between state directories: each run works under `<tempDir>/<hash of stateDir>/`, which it creates 0700 and refuses unless it is a real directory owned by the running user and closed to group and other (another local user who pre-creates that name, or a symlink of it, could otherwise redirect the run's files); a `tempDir` that other users can write needs the sticky bit, like `/tmp`. Every file under it is created owner-only (0700 directories, 0600 parts, never over an existing path).

Drive one batch from one `stateDir` at a time. The lock lives in the state directory, so two runners with different state directories (scheduled container tasks with ephemeral state, say) can both work on the same batch id. Each attempt re-reads the chunk manifest first and skips a chunk the other runner committed meanwhile, but two attempts that overlap on the same pending chunk still upload to the same part keys, and the later one can leave bytes under the earlier one's manifest. Verify and load catch that (the sha256 differs), export does not.

## Sizing

| Resource | Rule |
| --- | --- |
| Memory | about `export.concurrency x (s3.queueSize x s3.partSizeMb MiB + one keyset page)`; defaults: 4 x (4 x 16 MiB + 10,000 documents) |
| Disk | at most two parts per chunk (one being written, one uploading): `2 x concurrency x partMaxBytesMb` uncompressed worst case, plus `minFreeDiskMb` |
| Mongo | `concurrency` cursors on a `secondaryPreferred` read preference, `mongo.batchSize` documents per batch, `maxTimeMs` per operation |
| S3 | one multipart upload in flight per chunk, `queueSize` parts each |
| Time per chunk | one count, one read, one count; a field window restarts whole on a cursor error, so prefer `window: hour` above about 2,000,000 documents per day |

`inventory` suggests a strategy and window size per collection; `export --dry-run` prints the chunk list before anything is written.

## Disk reservation

Every open part reserves `export.partMaxBytesMb` and every load download reserves the manifest's `bytes` in a process-wide ledger. An open succeeds only when `free >= minFreeDiskMb + reserved + this reservation`; otherwise the chunk fails with `<tempDir>: N MB free, M MB needed (...)`. The first `ENOSPC` in a run retries the chunk; the second one ends the run with `out of space twice; lower concurrency or partMaxBytesMb`. Point `tempDir` at a volume with room for the worst case above.

## Signals

| Signal | Effect |
| --- | --- |
| first SIGINT or SIGTERM | chunks stop between documents, the upload in flight is abandoned (its HTTP request may still complete on the S3 side), the batch manifest is rewritten `interrupted` (or `complete` when the signal landed after the last chunk committed), the lock is released; exit 130 or 143 |
| second signal | the process exits at once; everything is still resumable |

Uploaded parts of an interrupted chunk stay in S3 (the tool never deletes objects) and are overwritten at the same keys when the chunk runs again. Add the lifecycle rule below so abandoned multipart uploads do not accumulate.

## Exit codes

Every command uses the same codes. When several apply, the signal codes win, then 1, then 4, then 3, then 2.

| Code | Meaning | What to do |
| --- | --- | --- |
| 0 | the run did everything it planned (also dry runs and nothing-to-do runs) | export: `verify --batch-id <b>`; verify: `infer`, then `load`; load: `reconcile` |
| 1 | config, env, connection, permission, lock, a declined or Ctrl+C'd prompt | read the message; fix; rerun (export and load resume from where they were) |
| 2 | export: flagged or failed chunks remain; verify: chunks could not be read after the retries; infer: a collection got no mapping; load: chunks skipped as unverified or mismatched, or failed; inventory: a collection could not be read | rerun with the same arguments once the cause is gone; see triage, and `load --allow-unverified` / `--allow-mismatch` when that is the decision |
| 3 | verify: a chunk is damaged, a batch is missing chunk manifests, or a batch manifest does not parse | [reading a verify report](acceptance.md#reading-a-verify-report) |
| 4 | reconcile: drift between the archive, the ledger and the tables | [repair](reconcile.md#repair); `--ignore <kinds>` accepts what is deliberate |
| 130 / 143 | interrupted by SIGINT / SIGTERM at any point after the command started its work: planning, listing, the DDL, the table locks, the chunks (inventory, export, verify, infer, load and reconcile alike) | rerun the same command; export resumes the batch, load resumes from `lines_done`, infer writes the collections it had not reached, inventory reports what it read |

## Triage

| Message | Cause | Action |
| --- | --- | --- |
| `[<chunk>] mismatch before N, after M, exported K (...); load needs --allow-mismatch` after the last attempt | documents were written or deleted in the window during the read, or `_id` values of a type outside the 8 brackets | rerun the batch in a quiet moment (the chunk is re-exported in place; it is never cached as done); for a busy small collection use `objectid-window` with `hour`; for odd `_id` types fix the data or accept the flag with `load --allow-mismatch` |
| `warning: <chunk> failed (parse): ...: a date is outside the JavaScript range` | a BSON date beyond +/-8.64e15 ms (a "never expires" sentinel); the driver cannot represent it and the archive would hold `NaN` | fix the value at the source, then rerun the batch |
| `warning: <chunk> failed (parse): ...: an embedded-document _id has an integer-like key` | JavaScript reorders such keys, so the id cannot be paged exactly ([limitations](limitations.md)) | export that collection with another tool, or change the ids |
| `manifest-only` chunk flagged `collection has N documents now; rerun the batch to plan it with a strategy` | the collection was empty at planning time and filled up before its chunk ran; nothing was written for it | rerun with the same `--batch-id`: planning sees the documents and exports the collection with its strategy |
| `<c>: no document has a BSON date in <field>; windows need a date field (or pass --include-rest ...)` | the window field holds strings or numbers, or `_id` is never an ObjectId, so no window can see anything | fix the strategy (another field, or `full-collection`), or export the collection as the rest chunk with `--include-rest` |
| `<c>: the oldest <field> is 0001-01-01T00:00:00Z, which gives N day windows (more than 100,000); set collections[].start` | a sentinel date (Go's or .NET's zero time; the epoch with `hour` windows) is the observed minimum | set `collections[].start` to the real start; older documents count as `before_start` and go to the rest chunk |
| `<c>: the oldest <field> is exactly 1970-01-01T00:00:00Z (the epoch, a sentinel in most data); set collections[].start` | the observed minimum is the epoch: with `day` windows that stays under the 100,000 limit and would plan about 20,000 nearly empty chunks | set `collections[].start` to the real start |
| `<c>: the oldest <field> is outside the JavaScript date range (a sentinel); set collections[].start` | a BSON date beyond +/-8.64e15 ms (a Long.MIN_VALUE "since forever" sentinel) is the observed minimum, which no grid can start at | set `collections[].start`; the sentinel documents count as `before_start` and go to the rest chunk |
| `N documents have no BSON date in <field> and are in no window` (or `have an _id that is not an ObjectId`) | type outsiders: a string or number where the window expects a date, a UUID or integer `_id` under `objectid-window` | let the rest chunk take them (`rest: export` or `--include-rest`); they are counted as `out_of_range.untyped` in the batch manifest |
| `--cutoff ... is in the future; the next --since last would skip what is written until then` | a planned retirement time, or a local time written as `Z` | pass a cutoff at or before now (the default is `now` minus the safety lag); a cutoff inside the lag only warns |
| `<c>: no ascending or descending index starts with <field>; timestamp-window needs one` (or `no complete (non-sparse, non-partial) ascending or descending index ...`, or `only a hidden index starts with <field>; unhide it or add one`) | `timestamp-window` on a field without an index, with only a sparse or partial one (hinted, it would undercount), only a hidden one (the planner refuses the hint), or only a hashed, text or other special index (it cannot bound a range) | create a plain visible index, or switch the strategy |
| `N documents before the start and M at or after the cutoff are in no window` | out-of-range values (fast clocks, future dates, explicit `start`) | let the rest chunk take them (`rest: export` or `--include-rest`), or accept the gap |
| `rest chunk skipped (rest: auto, about N documents)` | the collection is above 1,000,000 documents | set `rest: export` for that collection or pass `--include-rest`; the rest read is a scan for field windows |
| `export already running (pid P on H); pass --force-unlock if it is gone` | another export holds `<stateDir>/locks/export.lock` | let it finish; if it is gone, `--force-unlock` |
| `<tempDir>: ... MB free, ... MB needed` | not enough room for the reservation | free space, lower `export.concurrency` or `partMaxBytesMb`, move `tempDir` |
| `AccessDenied`, `NoSuchBucket`, `SignatureDoesNotMatch` (fatal, exit 1) | IAM or bucket config | fix the policy below or the config; the batch manifest was written `failed` and resumes |
| `<key>: HeadObject returned 403 (the role needs s3:GetObject on the prefix)` (fatal, exit 1) | a write-only role: every part upload is confirmed with a HEAD, which needs Get | grant `s3:GetObject` on the prefix (the policy below has it) |
| `the load ledger changed while waiting for the prompt or the locks; rerun load` | another loader finished a batch on the same table between this run's plan and its GET_LOCK | rerun load: the fresh plan sees the new ledger rows |
| `<c>: no key cast fits the sampled _id types (binary 60); no mapping written` (infer, exit 2) | UUID or double `_id` values, which none of the three key casts accept | archive the collection with a key the casts take, or map it by hand with `extraColumn` and a surrogate key |
| `retry mongo keyset page ... attempt 3` lines | a failover or a slow secondary | normal; the page restarts from its last id; raise `retry.attempts` if an outage lasts longer than about a minute (the default 8 attempts wait up to about 63 s in total, about 30 s on average) |
| `batch manifest not updated (...)` | the final rewrite failed after an interrupt | harmless; the next run with the same `--batch-id` rewrites it |
| `MongoDB 4.4+ or DocumentDB 5.0+ required: Server at ... reports wire version N ...` | the driver refuses the server | upgrade the source; see `docs/documentdb.md` |
| `Server selection timed out ... (through a tunnel or port forward, add directConnection=true to the URI ...)` | the driver discovered replica set members it cannot reach | add `directConnection=true` to `MSM_MONGO_URI`; see `docs/documentdb.md` |
| `--since last: no complete batch covers <c>` | every complete batch was exported with `-C` and left this collection out | run a full export of that collection first (`export -C <c>`), then the delta |
| `batch <b> is older than loaded <n> (<table>: <chunks>); include <n> with --reload or pass --allow-older` | an older batch would overwrite rows a newer batch wrote to that table | `load --reload --batch-id <b>,<n>` so the newer chunks replay last, or `--allow-older` when the older data is wanted |

## IAM

Attach [`iam-policy.json`](iam-policy.json) to the identity that runs `export`. It allows `s3:ListBucket` on the configured prefix, `s3:GetObject` and `s3:PutObject` on objects under it, `s3:AbortMultipartUpload` for interrupted uploads, and `kms:GenerateDataKey` plus `kms:Decrypt` on the key. Replace the bucket name, prefix and key ARN before attaching it; drop the KMS statement only when neither `s3.sse` nor the bucket's default encryption uses a customer-managed KMS key (objects in a bucket whose default encryption is SSE-KMS need `kms:Decrypt` to read and `kms:GenerateDataKey` to write whatever the tool sends).

- It grants no delete permission, and the tool never deletes an object. That alone does not make the archive safe from its writer: `s3:PutObject` overwrites, and on an unversioned bucket an overwrite loses the old bytes as surely as a delete would. Turn on bucket versioning (or S3 Object Lock) to get the no-loss property; the tool itself never overwrites a committed manifest, but a bug, a second runner or a stolen credential could.
- Hosts that only read need a smaller policy: `load`, `infer` and `reconcile` work with `s3:ListBucket` on the prefix, `s3:GetObject` under it and, for SSE-KMS objects, `kms:Decrypt`. `verify` writes only under `<prefix>/validation/*`, so give it `s3:PutObject` on that sub-prefix alone; its writes carry the configured `s3.sse` header, so with `aws:kms` (or a bucket default of SSE-KMS) it also needs `kms:GenerateDataKey` and `kms:Decrypt` on the key, or the first write fails with `AccessDenied`. `--no-write` needs none of that.
- Verify by default reads only the chunks that have no passing parse-check for their current manifest body, so a scheduled `verify` says nothing about a part overwritten after its first check. For periodic integrity checks run `verify --all`, which re-reads every chunk.

## MySQL privileges

`mysql.user` needs, on the target schema:

| Privilege | Why |
| --- | --- |
| `SELECT`, `INSERT`, `UPDATE`, `DELETE` on the target tables, the child tables and the three ledger tables (`_msm_load_chunks`, `_msm_load_rejects`, `_msm_load_keys`) | the upserts, the child replace, the ledger rows and the reconcile queries |
| `SELECT` on `information_schema` (every user has it for the tables it can see) | the shape check reads `COLUMNS` and `STATISTICS` |
| `CREATE` on the schema | only for `load --create-tables`, and for the ledger tables the first time: `load` runs `CREATE TABLE IF NOT EXISTS` for a ledger table only when it does not exist yet, so a DML-only user works once the three tables have been created |
| `CREATE TEMPORARY TABLES` on the schema | `reconcile --deep` builds its id table there |

The ledger DDL ships as [`docs/ledger.sql`](ledger.sql) (kept equal to what `load` runs by a unit test); a DBA can run it once and hand the loader a user without `CREATE`.

## Lifecycle rule for abandoned uploads

An interrupted or crashed export can leave multipart uploads that were never completed; S3 bills their parts until they are aborted. Add this rule to the bucket once:

```json
{
  "Rules": [
    {
      "ID": "abort-incomplete-multipart-uploads",
      "Status": "Enabled",
      "Filter": { "Prefix": "mongo-archive/" },
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 7 }
    }
  ]
}
```

`aws s3api put-bucket-lifecycle-configuration --bucket example-archive-bucket --lifecycle-configuration file://lifecycle.json`. Seven days is longer than any single upload and shorter than a billing cycle.

## Key ledger cost on the MySQL side

With `load.keyLedger: true` (the default) every loaded document writes one row of `_msm_load_keys`: about 2 x (key bytes + 30) bytes (the primary key plus the secondary index on `key_value`), or roughly 110 bytes per 24-character ObjectId key, about 250 GB for 2.2 billion documents. It is what lets `reconcile` prove table coverage without re-reading the archive. Turn it off for very large tables (`load.keyLedger: false`) and prove coverage with `reconcile --deep` instead, which reads every part once.
