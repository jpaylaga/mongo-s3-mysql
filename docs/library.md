# Using it as a library

Every command is a function that takes one options object, the clients it needs and a `RunContext`, and reports through `ctx.emit`. Library code never reads `process.env` and never prints; the CLI is a thin layer over these calls.

```ts
import { createContext, createMongo, createS3Store, exportArchive, loadConfig, selectCollections } from 'mongo-s3-mysql';

const config = await loadConfig('mongo-s3-mysql.config.json');
const uri = process.env[config.mongo.uriEnv] as string;
const ctx = createContext({ config, command: 'export', emit: (e) => console.error(JSON.stringify(e)), secrets: [uri] });
const mongo = await createMongo(config, uri);
const store = createS3Store(config.s3, ctx);
try {
  const result = await exportArchive({ ctx, mongo, store, collections: selectCollections(config), batchId: 'app-archive-full-2026-10' });
  process.exitCode = result.exitCode;
} finally {
  await mongo.close();
}
```

```ts
import { createContext, createMysql, createS3Store, load, loadConfig, reconcile, selectCollections } from 'mongo-s3-mysql';

const config = await loadConfig('mongo-s3-mysql.config.json');
const password = process.env[config.mysql!.passwordEnv] as string;
const ctx = createContext({ config, command: 'load', secrets: [password] });
const mysql = await createMysql(config.mysql!, password, config.load.concurrency + 2);
const store = createS3Store(config.s3, ctx);
try {
  await load({ ctx, store, mysql, collections: selectCollections(config), createTables: true });
  const proof = await reconcile({ ctx: { ...ctx, command: 'reconcile' }, store, mysql, collections: selectCollections(config) });
  if (proof.exitCode !== 0) console.error(proof.drifts);
} finally {
  await mysql.close();
}
```

## What is exported

| Group | Exports |
| --- | --- |
| orchestrators | `inventory` (`InventoryOptions` to `InventoryReport`), `exportArchive` (`ExportOptions` to `ExportResult`), `verify` (`VerifyOptions` to `VerifyResult`), `infer` (`InferOptions` to `InferResult`), `load` (`LoadOptions` to `LoadResult`), `reconcile` (`ReconcileOptions` to `ReconcileResult`); every result carries an `exitCode` |
| config | `configSchema` (zod), `parseConfig(input, baseDir, source?)`, `loadConfig(path)`, `selectCollections(config, names?)` (an empty result means every collection; the orchestrators discover them) |
| mapping | `mappingSchema` (zod), `loadMapping(path)`, `mappingToDdl(mapping)`, `transformLine(text, lineNo, tc)` |
| runtime | `createContext({ config, command, emit?, signal?, now?, secrets? })`, `toolVersion` |
| clients | `createMongo(config, uri)`, `createS3Store(s3, ctx, client?)`, `createMemoryStore(bucket?)`, `createMysql(mysql, password, connectionLimit)` |
| layout | `createLayout(s3)`, `listBatchManifests(store, layout)`, `listChunkManifests(store, layout, collection, batchId)`, `discoverCollections(store, layout)`, `readRecord(store, key, schema)`, `recordSchemas` |
| lines | `docToLine(doc)`, `readGzipLines(stream)` |
| types | everything in `src/types.ts` (`Config`, `Mapping`, `ChunkManifest`, `RunContext`, `MsmEvent`, `ObjectStore`, the options and result types, ...) |

## Conventions worth knowing

- `RunContext.signal` stops a run between documents or batches; `signal.reason` `'SIGTERM'` maps to exit 143, anything else to 130. The CLI wires the process signals to it.
- `RunContext.now` is the clock: fixing it fixes batch ids and load run ids, which is how the end-to-end tests stay deterministic.
- Pass a `confirm` function to get the CLI's prompts (`export`, `verify`, `load`, `reconcile --deep`); leave it out to run unattended.
- `createMemoryStore` is an `ObjectStore` over a `Map`, enough to drive `verify`, `infer`, `load` and `reconcile` in tests without S3.
- `createS3Store` retries every call through the context's retry settings (the body read of `getText` included) and refuses calls once `ctx.signal` is aborted; give it a context with a signal that never aborts when a final record must still be written after an interruption, as the CLI does.
- `ReconcileOptions.forceUnlock` replaces a stale `reconcile` lock, which only `--deep` takes.
- Events: `info`, `warn`, `chunk` (with a status), `retry` and `progress`; the CLI prints them as text or JSON lines, redacted with `ctx.secrets`.
