# Development

## Project layout

- One default export per file, named after the file (`types.ts`, `index.ts` and `cli.ts` excepted), and no named exports beside it: a helper two modules share gets its own file, and a test reaches a value through the default export; factories (`createX`), no classes.
- Each command reads as a call chain from its orchestrator: `exportArchive` -> `resolveBatch` -> `planChunks` -> `exportChunk` -> `createPartWriter` / `uploadPart` -> `buildChunkManifest`; `verify` -> `resolveBatches` -> `listManifests` -> `pendingChunks` -> `verifyChunk` -> `writeChecks` -> `checkCompleteness`; `load` -> `createPlanner` -> `selectChunks`, then `runChunks` -> `loadChunk` -> `transformLine` -> `createBatcher` -> `writeBatch`.
- Persisted records use `snake_case`, config and mapping files `camelCase`, in-process objects `camelCase`.

```
src/
  config/        configSchema, parseConfig, loadConfig, readConfigObject, selectCollections, bareCollection, instantSchema
  runtime/       createContext, msmError, isMsmError, classifyError, withRetry, runChunkAttempts, mapLimit, acquireLock,
                 checkFreeSpace, backoffDelay, redact, formatUtc, formatBytes, formatCount, createHashCounter, floorTo,
                 abortExitCode, tempDirOf, prepareTempDir, toolVersion, smallCollectionDocs, errorMessage, durations, fileExists
  layout/        createLayout, chunkRunId, parseChunkRunId, recordSchemas, readRecord, recordJson, listBatchManifests,
                 listChunkManifests, discoverCollections
  s3/            createS3Store, createMemoryStore, idleWatchdog, recordLimitBytes
  mongo/         createMongo, idBrackets, findBounds, streamCursor, streamKeyset, countDocs, objectIdAt
  ejson/         docToLine, readGzipLines, isObject, isWrapper, lineHasId
  inventory/     inventory, inventoryCollection, suggestStrategy, mergeConfigCollections
  export/        exportArchive, resolveBatch, planChunks, restGapTerm, canonicalFilter, exportChunk, createPartWriter, uploadPart,
                 buildChunkManifest, buildValidation, writeBatchManifest, createExportLedger
  verify/        verify, resolveBatches, listManifests, pendingChunks, checkCompleteness, writeChecks, verifyChunk, recordError
  mapping/       mappingSchema, identifierSchema, timeZoneSchema, loadMapping, resolveMappingPath, readPath, omitPaths, castValue,
                 textLimit, describeValue, maxDecimalExponent, formatWallClock, transformLine, valueColumns, mappingToDdl, clipBytes
  infer/         infer, sampleDocs, collectPathStats, chooseCast, buildMapping, identifier
  mysql/         createMysql, quoteId, readTableInfo, checkTableShape, ledgerDdl, missingLedgerDdl, keyLedgerKey, readLedger, upsertSql,
                 toSafeNumber, isNoSuchTable, fitIdentifier, acquireTableLock, markChunkFailed, markChunkReplayPending, replayPendingSha
  load/          load, createPlanner, readLedgers, selectChunks, runChunks, loadChunk, createBatcher, writeBatch, downloadPart, partPath,
                 dryRunResult, summarizePerTable
  reconcile/     reconcile, chunkDrift, tableCheck, deepCheck, keyExpr, driftSample
  cli/           commands/<name>Command, createProgram, resolveContext, confirm, installSignalHandlers, printEvent, printSummary,
                 escapeControl, escapeJsonControl, verifyClosing, nextCommand, defaultConfigPath, isInterrupted, exitCodes, parseList,
                 envSecrets, fatalMessage, runSecrets
  cli.ts index.ts types.ts
test/
  helpers.ts     example config, memory context, temp dirs (removed when the test ends), gzip
  fixtures/      synthetic sample lines and records with the real exporter's key sets
  unit/<dir>/    one test file per src file (cli, index and types excepted), no network, no Docker; the scripted MySQL
                 fake lives in unit/mysql/fakeMysql.ts, the scripted Mongo fake in unit/export/fakeMongo.ts
  e2e/           Testcontainers stack, twin seed, twin DDL, expected rows, CLI runner, the two suites
```

## Commands

```bash
npm ci
npm run typecheck          # tsc over src and test
npm test                   # unit suite (vitest, test/unit)
npm run build              # dist/ from src/
npm run test:e2e           # Docker required; about a minute once the images are pulled
```

- `npm test` runs with no network and no Docker. Fake collections, a memory object store and a scripted MySQL connection stand in for the real clients. `tmpDir()` registers its own removal with vitest's `onTestFinished`, and the e2e stack removes its work directory in `stop()` (set `MSM_E2E_KEEP=1` to keep it for a look).
- `docs/ledger.sql` is generated from `src/mysql/ledgerDdl.ts` and a unit test keeps the two equal; the shipped `examples/orders.mapping.json` carries the version it was generated with, and the tests normalise `inferred.tool` so a release bump does not fail them.
- The e2e suites start `mongo:7` (with authentication, so the connection string carries a password the output must never show), `mysql:8.0` and `adobe/s3mock` through Testcontainers, pinned by digest in `test/e2e/startStack.ts`. `MSM_E2E_S3=localstack` switches the S3 stand-in to `localstack/localstack` if the mock ever refuses an operation the tool needs; the pinned LocalStack release needs a license, so set `LOCALSTACK_AUTH_TOKEN` as well (it is forwarded into the container). A developer's `AWS_PROFILE` and `AWS_SESSION_TOKEN` are dropped for the run so the mock credentials are used.
- `test/e2e/roundTrip.test.ts` walks the whole pipeline on a seeded twin of a real migration, including an interrupted export, an interrupted load, a delta, a deleted row and a rewritten part. `test/e2e/existingArchive.test.ts` drives the built CLI against an archive written with only the original exporter's keys.
- The e2e runner drives `dist/cli.js`; `npm run test:e2e` builds first, and the runner rebuilds once per process anyway, so the built CLI is never stale.
- CI (`.github/workflows/ci.yml`) runs the unit suite on Node 22 and 24, greps for em and en dashes, builds, checks `--help`, then runs the e2e suite.

## Conventions

- Comments say why, not what. No em dashes or en dashes anywhere, including strings and docs.
- Shared types live in `src/types.ts` and are imported with `import type`; the zod schemas are the source of the config, mapping and record types.
- Library code never reads `process.env` and never prints; it gets clients and a `RunContext` and reports through `ctx.emit`. Only `cli/resolveContext.ts` (the configured secret names, plus the `cli/envSecrets.ts` scan) and the top-level catch in `cli.ts` (`cli/fatalMessage.ts`: the same scan plus the values resolveContext recorded in `cli/runSecrets.ts`) touch the environment.
- Every persisted or printed message passes through `redact`; secrets are the env values the run read.
- New behaviour gets a unit test next to its file and, when it changes what a command writes or reads, a step in the round trip.
