# Background

## Why it exists

- A production DocumentDB fleet was retired after its data moved into the application's MySQL tables, but the history had to stay readable: audits, disputes and reports reach back years.
- The exporter that archived that fleet wrote gzipped Extended JSON parts with manifests into S3. The layout was sound; the tooling around it was a set of one-off scripts: nothing resumed cleanly, nothing proved that a table held what the archive held, and every load was a hand-run import.
- This tool keeps the layout and replaces the scripts with one pipeline: `inventory`, `export`, `verify`, `infer`, `load`, `reconcile`. Each command is resumable, each one writes a record the next one checks, and the last one is a proof rather than a count.

## How it is used

- `export` runs under systemd with a fixed `--batch-id`; a restart resumes from the committed chunk manifests ([operations](operations.md)).
- `verify` runs after every batch, once against any archive before it is trusted, and as `verify --all` on a schedule to catch damage after the first check ([acceptance](acceptance.md)).
- `infer` writes a mapping to review; `load` upserts into the application's own tables through that mapping; `reconcile` runs on a schedule and exits 4 when a table drifts from the archive ([reconcile](reconcile.md)).

## Invariants

| # | Invariant |
| --- | --- |
| I1 | The chunk manifest is the commit record. A chunk is exported if and only if its manifest exists with `counts_match: true`; parts and validation records are written first, the manifest last. Local ledgers are caches. |
| I2 | The tool never deletes an S3 object. An unfinished or flagged chunk is rewritten at the same deterministic keys; a `counts_match: true` manifest is never overwritten. |
| I3 | Nothing is buffered whole. Export streams cursor to line to gzip (with a running sha256) to a temp file to S3; load streams S3 to a temp file (sha256 checked) to gunzip to line to a MySQL batch. |
| I4 | One layout. The tool writes and reads exactly the layout in [how it works](how-it-works.md): no format versions, no adapters. |
| I5 | Target tables are the user's. No mandatory tool columns; provenance columns are optional mapping entries. |
| I6 | Loads are idempotent and resumable. `INSERT ... ON DUPLICATE KEY UPDATE` on the mapping's key column; each batch transaction advances `lines_done` in the MySQL load ledger. |
| I7 | Secrets come only from the environment. The config names the variables; every printed or persisted message is redacted. |
| I8 | No em dashes or en dashes anywhere; CI greps for them. |

## What it is not

- Not change data capture: deletes never propagate and in-place updates arrive only when their window is re-exported ([limitations](limitations.md)).
- Not a schema migration tool: it creates tables only with `--create-tables`, from a mapping you reviewed, and never alters or drops anything.
- Not a general backup format: the archive is the exporter's layout, chosen because it already existed in production, not because it is the smallest or fastest.
