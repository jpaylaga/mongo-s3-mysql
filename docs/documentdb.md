# DocumentDB and MongoDB notes

The tool reads through the official MongoDB Node.js driver, so it works against MongoDB 4.4+ and Amazon DocumentDB 5.0+ alike. This page lists where the two differ in practice and what the tool does about it.

## Supported engines

- MongoDB 4.4 or newer; DocumentDB 5.0 or newer. The driver refuses older servers at connect time and the tool reports that as a config error (`MongoDB 4.4+ or DocumentDB 5.0+ required: Server at ... reports wire version N ...`) instead of starting a run.
- The tool only reads: `listCollections`, `listIndexes`, `estimatedDocumentCount`, `countDocuments`, `find` with `sort`, `hint`, `limit` and `maxTimeMS`. Nothing it needs is outside DocumentDB's compatibility surface.
- Views and time-series collections are listed by `inventory` but skipped; only plain collections are exported.

## Connection string

- `MSM_MONGO_URI` carries everything DocumentDB needs: `tls=true`, `tlsCAFile=<path to the regional CA bundle>`, the user and password. The client adds `retryWrites: false` itself (DocumentDB rejects retryable writes) and never writes, so a `retryWrites=false` in the URI is harmless either way.
- `mongo.readPreference` defaults to `secondaryPreferred`, which keeps exports off the primary. The driver discovers the replica set from the seed in the URI, with or without `replicaSet=rs0`, and routes reads to the members it finds. Through an SSH tunnel or a port forward those member hostnames are unreachable and connecting fails after the 30 s server selection timeout (the tool says so and names the fix): add `directConnection=true` to the URI, and every read then goes to that one node whatever `mongo.readPreference` says.
- A replica serves slightly stale data. Each chunk is counted before and after its read, so a document that lands during the read flags the chunk rather than being silently missed; busy collections export more cleanly in a quiet window or with `hour` windows.
- `appName` is `mongo-s3-mysql`, visible in the server's current operations.

## Index-name hints

- Every count and cursor passes a `hint` by index *name* (`_id_` for keyset reads, the chosen index for a `timestamp-window` field), and the chunk manifest records it as `filter.hint`. DocumentDB accepts hints by name only, MongoDB accepts both, so names are the common form.
- `timestamp-window` needs an index whose first key is the window field, in either direction. `listIndexes` picks the one with the fewest keys, skipping sparse and partial indexes (hinted, they return incomplete results for the rest chunk's "field is not a date" term), hidden indexes (the planner refuses a hint on one) and hashed, text or other special indexes (they cannot bound a range); without any such index the export stops before planning. `inventory` lists the fields that lead an index so the choice is visible up front.
- Index names on DocumentDB follow the same `field_1` convention as MongoDB when they were created without an explicit name; a renamed index is fine, the tool reads names from `listIndexes` and never guesses them.

## Counts and time limits

- `estimatedDocumentCount` drives the strategy suggestion and the `rest: auto` decision; on both engines it reads collection statistics, not the documents, so it can lag a little behind recent writes.
- `countDocuments` runs the exact window filter under the same hint as the read, which is what makes the before/after check meaningful.
- `mongo.maxTimeMs` (30 minutes by default) bounds every count, cursor and keyset page. A count that hits it fails the attempt and the chunk restarts; raise it for very large windows rather than splitting the collection by hand.

## Rest scans

- A windowed collection also gets a rest chunk: the documents outside every window, meaning window-field values that are not dates (`timestamp-window`), ids that are not ObjectIds (`objectid-window`), and anything before `start` or at or after the cutoff.
- The `objectid-window` rest filter is a set of `_id` ranges, so it stays index-bounded on both engines.
- The `timestamp-window` rest filter contains `{ field: { $not: { $type: 'date' } } }`, which no index bounds. Each keyset page then scans forward under the `_id` index until it finds matches, so a rest chunk over a large collection with few non-date values can read far more than it returns. The tool counts it under the field index hint and falls back to an unhinted count where the server refuses the hint.
- `rest: auto` therefore exports the rest only when the collection has at most 1,000,000 documents; set `rest: export` or pass `--include-rest` deliberately, and `rest: skip` on a busy cluster where the scan is not worth it. The batch manifest's `out_of_range` counts tell you how much a skipped rest would have held.

## Inventory on DocumentDB

- `inventory` samples the newest documents with `find().sort({ _id: -1 }).limit(n)`, reads `listIndexes`, and for ObjectId ids reads the lowest and highest `_id` under the `_id_` hint. All of it is read-only and bounded by `mongo.maxTimeMs`.
- The suggestion prefers `full-collection` up to 1,000,000 documents, `objectid-window` when every sampled id is an ObjectId (`hour` windows above 2,000,000 documents a day), and `timestamp-window` on an indexed field that is a date in at least 99% of the sample.
