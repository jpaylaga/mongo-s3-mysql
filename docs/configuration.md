# Configuration

`mongo-s3-mysql.config.json` (another path with `-c`), usually committed next to the application. Relative paths resolve against the file's directory. Every object is strict: an unknown key is an error, which is what catches a typo or a pasted secret.

```json
{
  "mongo": { "uriEnv": "MSM_MONGO_URI", "database": "app" },
  "s3": {
    "bucket": "example-archive-bucket",
    "prefix": "mongo-archive",
    "partition": { "account_id": "111122223333", "region": "us-east-1", "cluster": "example-cluster", "database": "app" },
    "region": "us-east-1"
  },
  "mysql": { "host": "mysql.example.internal", "user": "archive_loader", "database": "archive", "caFile": "global-bundle.pem" },
  "export": { "batchPrefix": "app-archive", "concurrency": 4 },
  "collections": [
    { "name": "audit_log", "strategy": "timestamp-window", "field": "created_at", "window": "day" },
    { "name": "orders", "strategy": "objectid-window", "window": "day" },
    { "name": "coupons", "strategy": "full-collection" }
  ]
}
```

- `mongo-s3-mysql init` writes this file; `inventory --write-config` fills `collections` from what it finds.
- An S3-compatible store adds `"endpoint": "http://127.0.0.1:9090"` and `"forcePathStyle": true` under `s3`.

## Secrets

Secrets never live in the file. The config names the environment variables that hold them, and a key that would hold one (`mongo.uri`, `mysql.password`, `s3.secretAccessKey`, anything matching `password`, `secret`, `token` or `credential`) is rejected with the env var to use instead.

| Variable | Used by | Holds |
| --- | --- | --- |
| `MSM_MONGO_URI` (`mongo.uriEnv`) | inventory, export | the MongoDB or DocumentDB connection string, including user and password |
| `MSM_MYSQL_PASSWORD` (`mysql.passwordEnv`) | load, reconcile | the MySQL password |
| `AWS_*` | export, verify, infer, load, reconcile | AWS credentials through the SDK's default chain (profile, env, instance role) |

## Keys

### `mongo`

| Key | Default | Meaning |
| --- | --- | --- |
| `mongo.uriEnv` | `MSM_MONGO_URI` | Env var with the connection string |
| `mongo.database` | required | Database to read |
| `mongo.readPreference` | `secondaryPreferred` | `primary`, `primaryPreferred`, `secondary`, `secondaryPreferred` or `nearest` |
| `mongo.batchSize` | `1000` | Cursor batch size (10 to 100,000) |
| `mongo.maxTimeMs` | `1800000` | `maxTimeMS` for every count, cursor and keyset page (30 minutes) |

### `s3`

| Key | Default | Meaning |
| --- | --- | --- |
| `s3.bucket` | required | Bucket name |
| `s3.prefix` | `""` | Key prefix in front of `raw/`, `manifests/` and `validation/`; leading and trailing slashes are dropped |
| `s3.partition` | `{}` | Ordered `key=value` path segments between `raw/` (or `manifests/`, `validation/`) and `collection=`; key order is path order; keys are `snake_case` and may not reuse a record key such as `run_id` or `collection` |
| `s3.region` | SDK default | Region of the bucket |
| `s3.endpoint` | none | Custom endpoint for an S3-compatible store; must not carry user info |
| `s3.forcePathStyle` | `false` | Path-style addressing, needed by most S3-compatible stores |
| `s3.storageClass` | `STANDARD` | `STANDARD`, `STANDARD_IA`, `INTELLIGENT_TIERING` or `GLACIER_IR` for the raw parts only; manifests, sidecars and validation records are small and rewritten often, so they stay `STANDARD` whatever this says |
| `s3.sse` | `none` | Server-side encryption: `none`, `AES256` or `aws:kms` |
| `s3.kmsKeyId` | none | Required with `aws:kms` |
| `s3.partSizeMb` | `16` | Multipart upload part size (5 to 512) |
| `s3.queueSize` | `4` | Multipart parts in flight per upload (1 to 16) |

### `mysql` (optional until `load` and `reconcile`)

| Key | Default | Meaning |
| --- | --- | --- |
| `mysql.host` | required | Host name |
| `mysql.port` | `3306` | Port |
| `mysql.user` | required | User; needs DML on the target tables plus the three ledger tables (`_msm_load_chunks`, `_msm_load_rejects`, `_msm_load_keys`), `CREATE` only until the ledger tables exist or for `--create-tables`, and `CREATE TEMPORARY TABLES` for `reconcile --deep` ([the privilege table](operations.md#mysql-privileges)) |
| `mysql.passwordEnv` | `MSM_MYSQL_PASSWORD` | Env var with the password |
| `mysql.database` | required | Schema that holds the target tables (at most 64 characters) |
| `mysql.tls` | `on` | `on` or `off` |
| `mysql.caFile` | none | CA bundle for TLS, relative to the config file |
| `mysql.sessionTimeZone` | `+00:00` | Session `time_zone` as `+HH:MM` (MySQL accepts `-13:59` to `+14:00`); `TIMESTAMP` columns read wall-clock strings in it, so use the application's connection time zone |
| `mysql.connectTimeoutMs` | `10000` | Connection timeout |

### Paths and disk

| Key | Default | Meaning |
| --- | --- | --- |
| `stateDir` | `.mongo-s3-mysql` | Locks and local ledgers (caches of what S3 already proves) |
| `tempDir` | `<stateDir>/tmp` | Parts are written here before upload and downloaded here before load |
| `mappingsDir` | `mappings` | Where `infer` writes and `load` reads `<collection>.mapping.json` |
| `minFreeDiskMb` | `2048` | Free space that must remain on `tempDir` after every part and download reservation |

### `retry`

| Key | Default | Meaning |
| --- | --- | --- |
| `retry.attempts` | `8` | Tries per operation (1 to 50). The waits are full-jitter backoff `rand(0, min(maxDelayMs, baseDelayMs x 2^(n-1)))`, so the default (7 waits) waits up to about one minute in total (about 30 s on average); an outage longer than that needs more attempts: `attempts: 10` (9 waits) up to about 3 minutes (about 1.5 on average), `attempts: 11` (10 waits) up to about 4 minutes (about 2 on average) |
| `retry.baseDelayMs` | `500` | First backoff delay; full jitter |
| `retry.maxDelayMs` | `60000` | Longest delay; must be at least `baseDelayMs` |

### `export`

| Key | Default | Meaning |
| --- | --- | --- |
| `export.batchPrefix` | `mongo-s3-mysql` | Batch ids are `<batchPrefix>-full-<start>` or `<batchPrefix>-delta-<start>` |
| `export.concurrency` | `4` | Chunks exported at once (1 to 64) |
| `export.partMaxDocs` | `5000000` | Documents per part before a new part starts |
| `export.partMaxBytesMb` | `1024` | Uncompressed bytes per part before a new part starts (1 to 8192) |
| `export.keysetPageDocs` | `10000` | Documents per keyset page (1 to 100,000) |
| `export.gzipLevel` | `6` | gzip level for parts (1 to 9) |
| `export.chunkAttempts` | `3` | Attempts per chunk, the first included (1 = no restart; 1 to 20); a count mismatch on the last attempt flags the chunk |
| `export.safetyLagMinutes` | `60` | The cutoff is `now` minus this, floored to the hour; an explicit `--cutoff` inside the lag warns, one in the future is refused |
| `export.deltaOverlapMinutes` | `60` | `--since last` starts this long before the newest complete batch's cutoff |
| `export.notes` | none | Free text (at most 500 characters) copied into the batch manifest |

### `verify`, `infer`, `load`

| Key | Default | Meaning |
| --- | --- | --- |
| `verify.concurrency` | `8` | Chunks verified at once (1 to 64) |
| `infer.sampleSize` | `10000` | Documents sampled across a collection's parts (1 to 1,000,000) |
| `infer.maxParts` | `50` | Parts the sample is spread over (1 to 10,000) |
| `infer.minPresence` | `0.01` | A field present in fewer sampled documents than this share gets no column |
| `infer.maxColumns` | `200` | Columns inferred per table (1 to 1000) |
| `load.concurrency` | `4` | Chunks loaded at once (1 to 64) |
| `load.batchRows` | `1000` | Rows per insert transaction (1 to 100,000); rejects count too |
| `load.batchMaxBytesMb` | `8` | Byte budget per insert transaction (1 to 256): the rows, their child rows, the rejects and the key ledger entries together; also capped by `max_allowed_packet` |
| `load.chunkAttempts` | `3` | Attempts per chunk, the first included (1 = no restart; 1 to 20) |
| `load.keyLedger` | `true` | Record every loaded key in `_msm_load_keys` (about 110 bytes per ObjectId document); off leaves `reconcile --deep` as the only coverage proof |

### `collections[]`

Export runs over this list and refuses an empty one; `-C a,b` narrows it (a name the list does not have gets the defaults). Verify, infer, load and reconcile discover every collection under the manifests prefix when the list is empty. Inventory also reads collections the list does not name with `--all`, and with an empty list it reads every collection.

`-C` on a resumed export runs only the selected collections' pending chunks; the batch manifest still tallies the whole frozen plan, so it stays `partial` until every collection's chunks are committed. `--since last` is resolved per collection, from the newest complete batch whose plan covers that collection, so per-collection cron lines never move another collection's delta start.

| Key | Default | Meaning |
| --- | --- | --- |
| `collections[].name` | required | Collection name; `system.*` is refused |
| `collections[].strategy` | none (inventory suggests one) | `timestamp-window`, `objectid-window` or `full-collection`; export needs it |
| `collections[].field` | none | Indexed date field, a dotted path for a nested one (`meta.ts`); required by `timestamp-window` and refused by the other strategies. The index must be a plain visible one: sparse, partial and hidden indexes are skipped, and so are hashed, text and other special indexes, which cannot bound a range |
| `collections[].window` | `day` | `hour` or `day`; windows sit on the UTC grid |
| `collections[].start` | observed minimum | First window as an ISO instant with an offset at second precision (`2026-10-12T00:00:00Z`); documents before it count as out of range. The same form is required by `--since` and `--cutoff`. A new batch freezes the start it derived (observed minimum or `--since`) into its manifest, so every resume plans the same windows. Required when the observed minimum would give more than 100,000 windows (a sentinel date such as 0001-01-01) |
| `collections[].rest` | `auto` | The rest chunk (documents outside every window): `auto` exports it in full batches up to 1,000,000 documents, `export` in every full batch, `skip` never; deltas need `--include-rest`, which forces it in any batch |
| `collections[].mapping` | `<mappingsDir>/<name>.mapping.json` | Mapping file `load` and `reconcile` read; `infer` always writes under `mappingsDir` (or `--out`) and warns when this points elsewhere |
