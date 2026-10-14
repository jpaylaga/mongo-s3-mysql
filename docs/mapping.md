# Mapping files

One file per collection. `infer` writes `<mappingsDir>/<collection>.mapping.json` (or under `--out`) from a sample of the archive, a person reviews it, and `load` and `reconcile` read `collections[].mapping` when it is set, else that same path. `infer` never writes to a configured `mapping` path, which is usually a curated file; when the two differ it says so, and the reviewed draft is copied or the config pointed at it. The mapping decides where each value comes from and how it is cast; the live table decides lengths, precision and NULL rules at load time ([shape check](#shape-check) below).

```bash
mongo-s3-mysql infer -C orders --key-column mongo_id --run-id-column import_run --chunk-column _msm_chunk --extra-column _extra --child-tables
# writes mappings/orders.mapping.json and mappings/orders.sql
```

- `infer` only reads S3 (the newest batch, or `--batch-id`). Neither file is overwritten without `--force`.
- [`examples/audit_log.mapping.json`](../examples/audit_log.mapping.json) loads into an existing application table with no schema change; [`examples/orders.mapping.json`](../examples/orders.mapping.json) is exactly what the command above writes for the test fixture with `infer.minPresence: 0.02` (the e2e config; at the default 0.01 the 1-in-60 `note` field earns a column).

## Schema

The file is strict: an unknown key is an error. Identifiers are MySQL identifiers (`[A-Za-z_][A-Za-z0-9_]{0,63}`).

| Key | Default | Meaning |
| --- | --- | --- |
| `collection` | required | Collection name as it appears in the archive |
| `table` | required | Target table |
| `key.column` | required | The column that holds `_id`: a single-column UNIQUE key or the single-column PRIMARY KEY; upserts dedupe on it |
| `key.cast` | `objectId` | `objectId` (`{"$oid"}` to 24 lowercase hex), `string` (a JSON string) or `bigint` (`$numberInt`, `$numberLong` or an integer) |
| `key.sqlType` | by cast | DDL hint for `--create-tables` and the `.sql` file; a `string` key takes `VARCHAR(n)` (default `VARCHAR(255)`, with `COLLATE utf8mb4_0900_bin`) or `VARBINARY(n)`; `CHAR` and `BINARY`, and with `load.keyLedger` on any `n` over 760, are refused before any table is created, since the shape check would refuse the result |
| `runIdColumn` | `null` | Column that gets the load run id (`load-<YYYYMMDDTHHMMSSZ>` or `--load-run-id`, 1 to 64 printable ASCII characters, no spaces); a CHAR, VARCHAR or TEXT column at least as wide as the run id; last writer wins |
| `chunkColumn` | `null` | Column that gets the `_msm_load_chunks.id` of the chunk that last wrote the row: `BIGINT`, `BIGINT UNSIGNED` or a text column; enables the per-chunk proof in `reconcile` |
| `extraColumn` | `null` | JSON (or text) column for every field no column or child consumed; NULL when nothing is left, so the live column must be nullable |
| `onCastError` | `reject` | `reject`: the line goes to `_msm_load_rejects` and no row is written; `null`: the column gets NULL and `cast_errors` counts it |
| `columns[]` | `[]` | Column mappings (below) |
| `children[]` | `[]` | Child tables for arrays (below) |
| `inferred` | none | What `infer` recorded: `at`, `tool`, `sampled`, `review[]`; informational, ignored by `load` |

### `columns[]`

| Key | Default | Meaning |
| --- | --- | --- |
| `column` | required | Target column |
| `source` | required | Dot path into the document (`data.request_input.page`); a numeric segment indexes an array; an Extended JSON wrapper such as `{"$date": ...}` is a leaf, never a path |
| `cast` | required | `string`, `int`, `bigint`, `double`, `decimal`, `bool`, `datetime`, `objectId` or `json` (the [cast table](#casts) below) |
| `default` | none | Value written when the source is missing or `null`; its JSON type must match the cast (string for `string` and `decimal`, integer for `int` and `bigint`, number for `double`, boolean for `bool`; none for `datetime`, `objectId`, `json`) |
| `fsp` | `0` | `datetime` only: fractional digits written, truncated |
| `timezone` | `UTC` | `datetime` only: IANA zone of the wall clock written |
| `round` | `reject` | `decimal` only: `reject` digits beyond the column scale, or round `half-up` like MySQL does |
| `sqlType` | by cast | DDL hint, like `VARCHAR(255)`, `DECIMAL(13,2)`, `DATETIME(3)` |
| `note` | none | Free text; `infer` writes its evidence here (`decimal 58, int 2`) |

### `children[]`

A child table gets one row per element of an array in the parent document. `load` deletes the child rows of the batch's keys, then inserts the elements, so a reload never duplicates them. Missing, null or empty arrays write no rows; a non-object element only feeds columns whose source is `"."` (the element itself).

| Key | Default | Meaning |
| --- | --- | --- |
| `table` | required | Child table, different from `table` |
| `source` | required | Path of the array in the parent |
| `parentColumn` | required | Column that gets the parent's key value |
| `indexColumn` | `null` | Column that gets the element's 0-based position |
| `columns[]` | required (min 1) | Column mappings with sources relative to the element; `"."` is the element itself |

### Rules

Every problem is reported at once, as `Invalid mapping <path>:` plus one line each.

1. Column names are unique case-insensitively across `key.column`, `columns[].column`, `runIdColumn`, `chunkColumn` and `extraColumn`.
2. No source equals, or is a segment prefix of, another source (columns and children together); no parent source starts with `_id` (the key covers it; inside a child, `_id` is the element's own field and may be mapped); `"."` only inside children.
3. `default` has the JSON type of its cast (table above).
4. `fsp` and `timezone` only on `datetime`; `round` only on `decimal`.
5. Child table names are unique and differ from `table`; inside a child, column names are unique together with `parentColumn` and `indexColumn`.

## Semantics at load

| Item | Rule |
| --- | --- |
| key | Always from `_id`. Any `_id` the key cast does not accept, or a missing `_id`, rejects the line whatever `onCastError` says |
| upsert | `INSERT ... ON DUPLICATE KEY UPDATE` sets every mapped column, `runIdColumn`, `chunkColumn` and `extraColumn`; never the key, never unmapped columns |
| missing or null | `default` when set, else SQL NULL; a JSON `null` in a `json` column is SQL NULL too. A NULL the live column cannot hold (NOT NULL, no mapping `default`) rejects the line, also under `onCastError: null` |
| child source not an array | an object or scalar where the mapping expects an array is a cast error: the line is rejected, or under `onCastError: null` counted and left in `extraColumn` |
| `json` | `JSON.stringify` of the raw subtree, wrappers (`$date`, `$numberDecimal`, `$binary`, ...) kept verbatim |
| `extraColumn` | the document minus `_id`, every column source and every child source |
| mapping changes | The load ledger records a sha256 of the mapping (`note`, `sqlType`, `$schema` and `inferred` excluded, since they change nothing the load does); a chunk loaded with another mapping is skipped with a warning until `load --reload` |

## Casts

`load` parses each line with `JSON.parse`, so the casts read the Extended JSON wrappers directly.

| Cast | Accepts | SQL value | Cast error when |
| --- | --- | --- | --- |
| `string` | JSON string | the string | `char`/`varchar`: more code points than the column length; text, `varbinary` and blob types: more UTF-8 bytes than the column holds; a character outside the column's character set (`utf8mb3` stops at U+FFFF, `latin1` is cp1252, `ascii` is 7-bit); not a member of an `ENUM` or `SET` column; into a numeric column: not a whole decimal literal (`""`, `"N/A"`; trailing whitespace is skipped, leading whitespace only before `DECIMAL`, `FLOAT` and `DOUBLE`, where an integer column takes only leading spaces and tabs), or the number (rounded like MySQL does) outside the column's range; into a JSON column: not valid JSON text |
| `int` | `$numberInt`, `$numberLong`, integer JSON number | number | outside the live column's integer range, more integer digits than a `DECIMAL(p,s)` column holds, or beyond 2^53 (`use cast bigint`) |
| `bigint` | `$numberInt`, `$numberLong`, integer number | decimal string | outside the range, or more integer digits than a `DECIMAL(p,s)` column holds |
| `double` | `$numberDouble`, `$numberInt`, `$numberLong` (abs <= 2^53), number | number | `NaN`, `Infinity`, `-Infinity` (MySQL cannot store them); outside `FLOAT`'s range; rounded outside an integer column's range; more integer digits than a `DECIMAL(p,s)` column holds |
| `decimal` | `$numberDecimal` (exact, never through a float), `$numberInt`, `$numberLong`, `$numberDouble` (its shortest round-trip string) | plain decimal string (`1.2E+3` becomes `1200`); `round: half-up` rounds to the column scale (`8.47723912345` becomes `8.4772391` in DECIMAL(10,7)) | digits beyond the scale under `round: reject`, too many integer digits (more than the column's, or than the 65 MySQL allows), an exponent beyond +/-6200, NaN or Infinity |
| `bool` | JSON boolean | 1 or 0 | anything else |
| `datetime` | `{"$date":{"$numberLong"}}`, `{"$date":"<iso>"}`, `{"$date": <integer>}` | the instant's wall clock in `timezone`, naive, exactly `fsp` digits, truncated | a numeric `$date` that is not an integer; outside the JavaScript date range (+/-8.64e15 ms, a "never" sentinel); year outside 1000..9999 (so any BC date); a `timestamp` column outside `1970-01-02 00:00:00`..`2038-01-18 23:59:59` |
| `objectId` | `{"$oid": h}` | lowercase hex | not 24 hex characters; a text column shorter than 24 characters (or 24 bytes); a JSON column |
| `json` | any | `JSON.stringify(raw)` | never for a JSON column; into a `char`/`varchar` or text column, the same length rule as `string`. A row larger than `max_allowed_packet` is rejected whole into `_msm_load_rejects` (`row larger than max_allowed_packet`), even under `onCastError: null` |

- Every cast is also bound by the live column's family: any value into a `char`, `varchar`, text or binary column is checked against that column's length and character set (a number into `VARCHAR(5)`, an ObjectId into `CHAR(12)`), a `datetime` or `objectId` into a JSON column is a cast error, a number (`int`, `double`, `bool`) into a JSON column is sent as its text (MySQL refuses an unquoted number there, error 3140; `bigint` and `decimal` are text already), a `json` text into a numeric column follows the `string` rule, and a number into an `ENUM` or `SET` column is read as MySQL reads it (the 1-based member index, or a bit mask over the members; `bigint` and `decimal` texts match a member by text first), so an index outside the members, a non-integer, a date or an ObjectId there is a cast error. What can never fit (an `objectId` key or column on a numeric column or one shorter than 24, a `json` cast on a numeric column) is a shape problem before the load starts.
- Other wrappers (`$binary`, `$regularExpression`, `$timestamp`, ...) are valid only in `json` columns and the extra column, verbatim.
- Relaxed lines (bare numbers) are accepted. A bare integer beyond 2^53 was already rounded by `JSON.parse`, so two source values can arrive as one number: `int`, `bigint`, `decimal` and the key reject such a line (`precision already lost`) instead of merging documents; write such values canonically (`$numberLong`). A string `$date` must carry `Z` or an offset; one without is rejected rather than read in the loader host's time zone. A `$numberDouble` payload must be a decimal literal (no `""`, hex or octal).
- A `datetime` into a `TIMESTAMP` column is read by MySQL in the session time zone. Set `mysql.sessionTimeZone` to the application's connection `time_zone` and the mapping's `timezone` to the zone the application writes in, so imported rows read like the application's own rows. The twin example writes `{"$date":{"$numberLong":"1772409601527"}}` (2026-03-02T00:00:01.527Z) as `'2026-03-02 08:00:01'` with `timezone: Asia/Manila` and `fsp: 0`.

## Shape check

Before writing, `load` reads the live table from `information_schema` and refuses to run on any of these (all listed together):

- a table or child table missing (the `.sql` file or `--create-tables` creates it);
- the key column missing, or neither a single-column PRIMARY KEY nor a single-column UNIQUE key, or only a prefix index on it (`UNIQUE (k(10))` collides on the prefix in MySQL but not in the loader);
- any other UNIQUE key, except an unwritten `AUTO_INCREMENT` PRIMARY KEY (an upsert could hit the wrong row);
- a mapped, run id, chunk, extra, `parentColumn` or `indexColumn` column missing;
- an unmapped `NOT NULL` column without a default that is not `AUTO_INCREMENT` or generated;
- a `string` key (or a child's `parentColumn` under one) whose collation is not NO PAD binary (`utf8mb4_0900_bin`, or a VARBINARY column: `o-1` and `O-1` would merge under a case-insensitive one, `a` and `a ` under `utf8mb4_bin` or `ascii_bin`, canonically equivalent strings under `utf8mb4_0900_as_cs`), or whose type is CHAR or BINARY (trailing bytes are stripped or padded);
- a `datetime` `fsp` above a DATETIME, TIMESTAMP or TIME column's (MySQL would round), or a datetime into a string column too short for the literal (`19 + fsp + 1` characters);
- an `objectId` key or column on a numeric column or one shorter than 24 characters, or a `json` cast on a numeric column (no value could ever fit);
- a `runIdColumn` that is not a string column, or shorter than the run id the load will write;
- a `chunkColumn` that is not `BIGINT`, `BIGINT UNSIGNED` or a text column; an `extraColumn` that is not JSON or text, or that is `NOT NULL` (a fully mapped document leaves it NULL);
- with `load.keyLedger` on, a key column over 760 characters (the ledger stores `key_value` as VARCHAR(760)); a missing table whose `key.sqlType` declares such a width gets no DDL, so `--create-tables` never creates a table this rule would then refuse;
- with `load.concurrency` above 1, a child `parentColumn` without an index (every batch's DELETE would scan the child table, and concurrent scans deadlock).

Warnings: a mapped `NOT NULL` column without `default` (a missing, null or uncastable field then rejects the line); an unindexed chunk column; an unindexed child `parentColumn` at concurrency 1; a `TIMESTAMP` column whose cast `timezone` has a different UTC offset than `mysql.sessionTimeZone` (the warning names both; MySQL reads the literal in the session zone, so infer's default `UTC` under an application's `+08:00` session would shift every row by eight hours). The live column limits feed the casts above.

`--create-tables` runs the mapping's `CREATE TABLE IF NOT EXISTS` statements, the same ones `infer` writes to `<collection>.sql`: a surrogate `id BIGINT UNSIGNED AUTO_INCREMENT` primary key plus the key column as a nullable UNIQUE column, so application rows and imported rows can share the table. A mapped column named `id` is refused unless it is the key itself, which then becomes the primary key with no surrogate. The tool never runs `ALTER`, `DROP` or `TRUNCATE`.

## What infer writes

`infer` samples the archive and writes one column per top-level field in first-seen order:

- `infer.sampleSize` documents from at most `infer.maxParts` parts, spread evenly over the batch's chunks; within a part every k-th line, k rounded up so the newest parts are reached.
- Without `--batch-id`, each collection is sampled from the newest finished full batch that holds documents of it (a delta holds only its last windows, so types that only older documents carry would be missed), falling back to the newest delta when no full batch holds it; the info line names the batch and its kind.
- The files go to `<mappingsDir>/<collection>.mapping.json` and `<collection>.sql`, or under `--out <dir>`; a collection whose config names another `mapping` path gets a warning saying where `load` will look.
- Flags: `--table` (one collection only, used verbatim), `--key-column` (default `mongo_id`), `--run-id-column`, `--chunk-column`, `--extra-column` (none by default), `--timezone` (default `UTC`, applied to every datetime), `--child-tables`, `--batch-id`, `--out`, `--force`.
- A collection that gets no mapping (no documents, or no sampled `_id` fits a key cast) is reported and the command exits 2 once the others are written; an interrupt returns the files written so far with exit 130 or 143.

| Observed in the sample | `cast` | `sqlType` |
| --- | --- | --- |
| present in fewer than `infer.minPresence` of the documents | no column: left to the extra column, or dropped, with a review line | |
| only `$oid` | `objectId` | `CHAR(24)` |
| only strings | `string` | `VARCHAR(n)`, n from 32, 64, 128, 255, 512, 1024 at or above 1.5 x the longest value; else `TEXT` (up to 16,000 bytes seen) or `MEDIUMTEXT` |
| only `$numberInt` | `int` | `INT` |
| `$numberLong`, with or without `$numberInt` | `bigint` | `BIGINT` |
| `$numberDouble`, with or without integers | `double` | `DOUBLE` |
| `$numberDecimal`, with or without integers | `decimal` | `DECIMAL(p,s)` from the integer digits and scale seen, with headroom; scale clamped to 30 and precision to 65 (a clamped column gets `round: half-up` and a review line); over 65 integer digits becomes `json` |
| only booleans | `bool` | `TINYINT(1)` |
| only `$date` | `datetime`, `fsp: 3`, `timezone` from `--timezone` | `DATETIME(3)` |
| objects, arrays, other wrappers, any mix of types | `json` | `JSON` (a mix gets a review line) |
| arrays of objects with `--child-tables` | a child table `<table>_<field>` with a column per element field; an element's own `_id` (the Mongoose default) becomes a column too | per element field, same table |

- Nulls are ignored when choosing the type; every column is nullable with no `default`, and carries `sqlType` and an evidence `note` (`decimal 58, int 2`).
- `key.cast` follows the `_id` values seen: all `$oid` gives `objectId`, all strings `string`, all integers `bigint`; a mix takes the majority and adds a review line, since the other lines will be rejected. When no sampled `_id` fits any of the three (UUID binaries, doubles), no mapping is written and the collection counts as failed.
- A string key is sized from its own ladder, `VARCHAR(32)` to `VARCHAR(760)` (the key ledger's width, inside InnoDB's utf8mb4 index limit), never TEXT; a sampled `_id` over 760 characters gets a review line, since such a key can be neither indexed nor recorded.
- MySQL counts every utf8mb4 `VARCHAR(n)` as `4n + 2` bytes against a 65,535-byte row limit. When the chosen columns would exceed it (32 fields of `VARCHAR(512)` do), the widest `VARCHAR` columns (the last one on a tie) become `TEXT` until the row fits, each with a review line, so the `.sql` file is valid as written; child tables get the same rule on their own.
- `inferred.review` lists every decision worth a look: dropped fields, mixed types, clamped decimals, minority `_id` types. The same lines are printed as warnings.
- Nested fields are not mapped: objects become `json` columns; replacing one with dot-path columns is a manual edit.

Identifiers are derived from the field and collection names (`snake`: split camel humps, lowercase, every run outside `[a-z0-9_]` becomes `_`, trim `_`):

| Name | Rule | Example |
| --- | --- | --- |
| column | `snake(field)`; empty: the field as is; leading digit: `_` prefix | `createdAt` to `created_at`, `Device ID` to `device_id`, `2fa` to `_2fa` |
| table | `--table` as typed, else `snake(collection)` | `audit-log` and `audit.log` to `audit_log`; `--table ArchivedOrders` stays `ArchivedOrders` |
| child table | `<table>_<snake(field)>` | `orders_items` |
| `parentColumn` | `<table minus one trailing s>_<key column>` | `order_mongo_id` |
| `indexColumn` | `<snake(field) minus one trailing s>_index` | `item_index` |
| reserved | parent: `id`, the key, run id, chunk and extra columns; child: `id`, `parentColumn`, `indexColumn` | a field `id` becomes `id_2` |
| collision | case-insensitive clash with an earlier or reserved name: suffix `_2`, `_3`, ... | `created_at` and `createdAt` to `created_at`, `created_at_2` |
| length | over 64 characters: the first 57, `_`, then 6 hex of sha1 of the full name | |

Index names in the `.sql` file are `uq_<table>_<key>`, `ix_<table>_<chunk>` and `uq_<child>_parent`, shortened by the same length rule.

## Reviewing a mapping

1. Read `inferred.review`: a field left to the extra column may deserve a column; a minority `_id` type means those documents will be rejected.
2. Compare `sqlType` hints with the application's conventions before running the `.sql` file, or drop the hints and point `table` at an existing table (the twin example).
3. Set `timezone` on every `datetime` to the zone the application writes in, and `mysql.sessionTimeZone` to its connection `time_zone`.
4. Add `default` values where the target column is `NOT NULL`.
5. Run `load --dry-run`: it reports the shape check and what would be loaded without writing.
