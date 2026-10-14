# Acceptance against an existing archive

The tool reads the layout its own `export` writes, which is the layout of the production exporter it replaced ([how it works](how-it-works.md)). This page is the checklist for proving that on an archive the tool never wrote: no MongoDB involved, read-only S3 credentials, and MySQL only in the last steps.

`test/e2e/existingArchive.test.ts` runs the same steps against records that carry only the original exporter's key sets (spaced canonical lines, a BOM on one part, the extra keys `area`, `covered_areas` and `notes`) under a batch id the tool did not generate.

## 1. Config

Point the config at the archive: `s3.bucket`, `s3.prefix` and `s3.partition` exactly as the keys read (every `key=value` segment between `manifests/` and `collection=`, in path order). Leave `collections` empty so verify, infer, load and reconcile discover the collections from the manifests prefix, or list the ones you want (a listed collection needs a mapping file before `load` touches it).

```json
{
  "mongo": { "database": "app" },
  "s3": {
    "bucket": "example-archive-bucket",
    "prefix": "mongo-archive",
    "partition": { "account_id": "111122223333", "region": "us-east-1", "cluster": "example-cluster", "database": "app" },
    "region": "us-east-1"
  },
  "mysql": { "host": "mysql.example.internal", "user": "archive_loader", "database": "archive" }
}
```

The credentials in the AWS default chain need `s3:ListBucket` on the prefix and `s3:GetObject`; nothing else until step 4 ([iam-policy.json](iam-policy.json) is the superset the tool's own exports need).

## 2. Verify without writing

```bash
mongo-s3-mysql verify --no-write --batch-id <batch id>
```

`--no-write` keeps the archive untouched: the validation records stay as the exporter wrote them, and the verdict is printed instead. The run reads every part of every chunk of the batch that has no passing parse-check for its current manifest body (pass `--all` to re-read the verified ones too, which is what a periodic integrity check wants) and checks, per chunk:

| Check | Rule |
| --- | --- |
| record | the manifest parses; its partition fields equal the config; the run id's mode equals `mode`; `counts_match` agrees with `source_count` and `exported_count` |
| shape | `file` is null exactly when there are no parts; `exported_count` is 0 without parts; a `manifest-only` chunk has `format: manifest_only` and null ids; every `s3_uri` is under the bucket and the chunk's raw prefix |
| object | the object size equals `bytes`; the sidecar body is `<sha256>  <part name>` |
| content | the streamed sha256 and byte count equal the manifest's; gunzip succeeds; every line parses as JSON and has an `_id`; the line total equals `exported_count` |

The batch manifest's `completed_chunks` is compared with the chunk manifests found over every archived collection (whatever `collections` lists), so a lost manifest is reported as a missing chunk; only `-C` skips that comparison, since a narrowed run cannot be counted against the batch. A chunk manifest that does not parse is reported as one damaged chunk and the others are still read.

| Exit | Meaning |
| --- | --- |
| 0 | every chunk passed and the batch is complete |
| 2 | some chunks could not be read (S3 errors after retries); rerun |
| 3 | a chunk is damaged or missing; the errors are listed per chunk in the output and in `parse-check.json` when writing is allowed |

A passing run proves the archive is intact. With write access, drop `--no-write` so the parse-check records carry the verdict and `load` can rely on it; otherwise `load` needs `--allow-unverified`, which still re-checks every part's sha256 while loading.

## 3. Infer a mapping

```bash
mongo-s3-mysql infer --batch-id <batch id>
```

Writes `<mappingsDir>/<collection>.mapping.json` and `<collection>.sql` per collection from a sample of the archived lines. Edit the mapping to the target table's rules ([mapping](mapping.md)): the key column, which fields become columns, time zones for `datetime` casts, and what `extraColumn` should keep.

## 4. Load

```bash
mongo-s3-mysql load --batch-id <batch id> --allow-unverified --dry-run
mongo-s3-mysql load --batch-id <batch id> --allow-unverified
```

The dry run lists the chunks, documents and DDL; it reads the table shapes and the ledger but writes nothing. `--allow-unverified` is needed only when step 2 ran with `--no-write`; the part checksums are checked again during the load either way.

## 5. Reconcile

```bash
mongo-s3-mysql reconcile --batch-id <batch id>
mongo-s3-mysql reconcile --batch-id <batch id> --deep
```

Exit 0 means every chunk of the batch is loaded, the ledger counts agree with the manifests and every key the load wrote has a row. `--deep` re-reads the parts and proves row by row that each archived `_id` is in the table ([reconcile](reconcile.md)).

## Reading a verify report

Each chunk's `parse-check.json` (written unless `--no-write`) holds the full verdict:

```json
{ "run_id": "<r>", "collection": "audit_log", "mode": "timestamp-window",
  "gzip_test": true, "first_line_parseable": true, "first_line_has_id": true, "manifest_only": false,
  "ok": true, "lines": 48211, "parse_errors": 0, "missing_ids": 0, "bytes_ok": true, "sha256_ok": true, "sidecar_ok": true,
  "manifest_sha256": "<sha256 of the manifest object body>", "verified_at": "2026-10-13T03:00:00+00:00",
  "errors": [], "tool": "mongo-s3-mysql@0.1.0" }
```

- `manifest_sha256` pins the verdict to the exact manifest body; a rewritten manifest makes the chunk unverified again, so the next `verify` re-reads it and `load` refuses it until then.
- `errors` is one line per failed check, for example `part-000001.jsonl.gz: sha256 0c3f2a... differs from the manifest's 4a1b2c...` or `47 lines, exported_count 48`.
- Booleans are null when there was nothing to test: every one of them for a `manifest-only` chunk or an empty window; every content boolean when all parts are addressed outside the chunk's bucket or raw prefix (no part is read); `gzip_test` when the text (invalid UTF-8, a line over 256 MiB) rather than the compression stopped the decoding; `sha256_ok` and `gzip_test` when a part's object is missing, whether at the head, the first read or the hash-only second read, and no other part gave a verdict (`bytes_ok` is false then, and `errors` names the missing part). After a gunzip failure the object is read again for its size and digest, so `bytes_ok` and `sha256_ok` are true or false and `gzip_test` is false.
- `errors` names the field when the manifest itself does not parse (`record: ... invalid record; ... exported_count ...`); the chunk's `counts.json` is left as the exporter wrote it.

Repair depends on what failed and on who wrote the batch:

| Failure | Batch written by | Action |
| --- | --- | --- |
| a chunk manifest is missing, or flagged `counts_match: false` | this tool | `export --batch-id <id>` while the source collection still exists: the chunk is written again at the same keys (the tool never deletes objects and never overwrites a `counts_match: true` manifest) |
| the same | another exporter | there is no frozen plan to resume. Set `MSM_MONGO_URI`, give the collection a config entry with a strategy (`inventory -C <c> --write-config`, or by hand), then `export -C <c> --batch-id <new>`, and verify and load that batch. This step alone needs the source |
| the batch manifest does not parse (`invalid batch manifest`, reported on its own) | either | export reads that manifest first and cannot resume the batch: restore the object from bucket versioning |
| a damaged part under a `counts_match: true` manifest | either | a loss the archive cannot repair by itself: restore the object from bucket versioning or a replica, or export the window again under a new batch id |
| a failed parse-check | either | `load` refuses the chunk until the check passes or `--allow-unverified` is given |
