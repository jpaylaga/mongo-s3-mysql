import type { Readable, Transform } from 'node:stream';
import type { Db, Document, MongoClient } from 'mongodb';
import type { Connection, Pool } from 'mysql2/promise';
import type { z } from 'zod';
import type exitCodes from '#cli/exitCodes';
import type configSchema from '#config/configSchema';
import type recordSchemas from '#layout/recordSchemas';
import type mappingSchema from '#mapping/mappingSchema';

// Config and mapping
export type Config = z.infer<typeof configSchema>;
export type S3Config = Config['s3'];
export type MysqlConfig = NonNullable<Config['mysql']>;
export type CollectionConfig = Config['collections'][number];
export type Strategy = 'timestamp-window' | 'objectid-window' | 'full-collection';
export type Mapping = z.infer<typeof mappingSchema>;
export type ColumnMapping = Mapping['columns'][number];
export type ChildMapping = Mapping['children'][number];
export type Cast = ColumnMapping['cast'];

export interface LoadedMapping {
  path: string;
  mapping: Mapping;
  sha256: string;
}

// Records (section 6)
export type ChunkMode = Strategy | 'manifest-only';
export type ChunkManifest = z.infer<typeof recordSchemas.chunkManifest>;
export type BatchManifest = z.infer<typeof recordSchemas.batchManifest>;
export type CountsRecord = z.infer<typeof recordSchemas.counts>;
export type ParseCheckRecord = z.infer<typeof recordSchemas.parseCheck>;

export interface Window {
  start: Date;
  end: Date;
}

export interface ChunkRunIdParts {
  mode: ChunkMode;
  window: Window | null;
  tail: 'window' | 'full' | 'rest';
}

/** `lines` null: a single-part manifest without `parts[]`; it then equals `exported_count`. */
/**
 * `key` null: the `s3_uri` is outside the chunk's raw prefix (or the bucket), so no reader may
 * fetch it.
 */
export interface PartRef {
  key: string | null;
  name: string;
  bytes: number;
  sha256: string;
  s3_uri: string;
  checksum_s3_uri: string | null;
  lines: number | null;
}

export interface ResolvedManifest {
  key: string;
  sha256: string;
  text: string;
  manifest: ChunkManifest;
  batchId: string;
  collection: string;
  runId: string;
  id: ChunkRunIdParts;
  parts: PartRef[];
}

export interface Layout {
  bucket: string;
  partition: Record<string, string>;
  rawPrefix(collection: string, window: Window | null, runId: string): string;
  part(rawPrefix: string, n: number): string;
  chunkManifest(collection: string, runId: string): string;
  chunkManifestPrefix(collection: string, batchId: string): string;
  collectionsPrefix(): string;
  batchManifest(batchId: string): string;
  batchesPrefix(): string;
  counts(collection: string, runId: string): string;
  parseCheck(collection: string, runId: string): string;
  uri(key: string): string;
  keyOf(uri: string): string | null;
}

// Object store
export interface ObjectStore {
  bucket: string;
  putFile(
    key: string,
    path: string,
    opts: { contentType: string; metadata?: Record<string, string>; signal?: AbortSignal }
  ): Promise<void>;
  putText(key: string, body: string, contentType: string): Promise<string>; // sha256 of body
  head(key: string): Promise<{ bytes: number } | null>;
  /**
   * `maxBytes` caps the body (default `recordLimitBytes`): a larger object is a `record` error,
   * never a string of its size.
   */
  getText(key: string, maxBytes?: number): Promise<string | null>;
  getStream(key: string): Promise<Readable | null>;
  list(prefix: string, delimiter?: string): Promise<{ keys: string[]; prefixes: string[] }>;
}

// Runtime
export type CommandName = 'inventory' | 'export' | 'verify' | 'infer' | 'load' | 'reconcile';
export type ChunkStatus = 'done' | 'skipped' | 'mismatch' | 'failed' | 'interrupted';

export type MsmEvent =
  | { type: 'info' | 'warn'; command: CommandName; message: string }
  | {
      type: 'chunk';
      command: CommandName;
      chunk: string;
      status: ChunkStatus | 'start' | 'retry' | 'part';
      detail?: string;
    }
  | {
      type: 'retry';
      command: CommandName;
      source: 'mongo' | 's3' | 'mysql';
      name: string;
      attempt: number;
      delayMs: number;
      error: string;
    }
  | { type: 'progress'; command: CommandName; done: number; total: number; docs: number };

export type EventSink = (event: MsmEvent) => void;

export interface RunContext {
  config: Config;
  command: CommandName;
  emit: EventSink;
  signal: AbortSignal;
  now: () => Date;
  secrets: readonly string[];
}

export type FailureCode =
  | 'config'
  | 'record'
  | 'disk'
  | 'mongo'
  | 's3'
  | 'mysql'
  | 'sha256'
  | 'count_mismatch'
  | 'parse'
  | 'cast'
  | 'insert_race'
  | 'lock'
  | 'interrupted'
  | 'unknown';

export interface MsmError extends Error {
  msmCode: FailureCode;
  retriable: boolean | null;
  fatal: boolean;
}

export interface ErrorClass {
  code: FailureCode;
  retriable: boolean;
  chunkRetriable: boolean;
  fatal: boolean;
  aborted: boolean;
}

export interface ChunkOutcome {
  chunk: string;
  collection: string;
  status: ChunkStatus;
  docs?: number;
  code?: FailureCode;
  error?: string;
  note?: string;
}

export type ExitCode = (typeof exitCodes)[keyof typeof exitCodes];

// Mongo and inventory
export interface MongoHandle {
  client: MongoClient;
  db: Db;
  close(): Promise<void>;
}

export interface IdBracket {
  name: string;
  types: string[];
  lowest: unknown;
}

/** What `inventoryCollection` observed, before a strategy is attached to it. */
export interface InventoryFacts {
  name: string;
  estimatedCount: number;
  indexedFields: string[];
  idTypes: Record<string, number>;
  dateFields: { field: string; ratio: number; indexed: boolean }[];
  objectIdTime: { min: string; max: string } | null;
}

export interface CollectionInventory extends InventoryFacts {
  suggestion: CollectionConfig & { reason: string; warn: boolean };
}

export interface InventoryOptions {
  ctx: RunContext;
  mongo: MongoHandle;
  names?: string[];
  all?: boolean;
  sampleSize?: number;
}

export interface InventoryReport {
  collections: CollectionInventory[];
  skipped: { name: string; reason: string }[];
  exitCode: ExitCode;
}

// Export
export type BatchStatus = 'running' | 'complete' | 'partial' | 'interrupted' | 'failed';

export interface PlannedCollection {
  collection: string;
  mode: Strategy;
  field: string | null;
  window: 'hour' | 'day' | null;
  start_utc: string | null;
  rest: boolean;
}

/**
 * `untyped`: documents whose window field is not a date (or whose `_id` is not an ObjectId); absent
 * in older manifests.
 */
export interface OutOfRange {
  before_start: number;
  after_cutoff: number;
  untyped?: number;
}

export interface BatchPlan {
  batchId: string;
  kind: 'full' | 'delta';
  cutoff: Date;
  since: Date | null;
  startedAt: Date;
  collections: PlannedCollection[];
  includeRest: boolean;
  resumed: boolean;
  outOfRange: Record<string, OutOfRange>; // batch manifest `out_of_range`
}

/**
 * A rest chunk's live-write gap: the last `$or` term of `filter` is rebuilt per attempt to start a
 * day after the attempt.
 */
export interface LiveGap {
  key: string;
  kind: 'date' | 'objectId';
  startedAt: Date;
}

export interface ChunkPlan {
  collection: string;
  runId: string;
  mode: ChunkMode;
  tail: 'window' | 'full' | 'rest';
  filter: Document;
  filterRecord: Record<string, unknown>; // count+read filter; manifest `filter`
  hint: string | null; // index name for counts and cursors; keyset reads always hint `_id_`
  paging: 'cursor' | 'keyset' | 'none';
  brackets: IdBracket[]; // cursor: field windows only
  rawPrefix: string;
  liveGap?: LiveGap;
}

export interface ClosedPart {
  n: number;
  path: string;
  name: string;
  bytes: number;
  sha256: string;
  lines: number;
}

export interface HashCounter {
  stream: Transform;
  digest(): string;
  bytes(): number;
}

export interface PartWriter {
  write(line: string): Promise<ClosedPart | null>;
  finish(): Promise<ClosedPart | null>;
  abort(): Promise<void>;
}

export interface ManifestInput {
  plan: ChunkPlan;
  partition: Record<string, string>;
  sourceCount: number;
  sourceCountAfter: number;
  exported: number;
  firstId: string | null;
  lastId: string | null;
  parts: PartRef[];
  startedAt: Date;
  completedAt: Date;
  toolVersion: string;
}

/**
 * One committed chunk as the local cache records it; the key and bucket tie the line to one layout.
 */
export interface ExportLedgerEntry {
  manifest_key: string;
  bucket: string;
  manifest_sha256: string;
  exported_count: number;
}

export interface ExportLedger {
  read(): Promise<Map<string, ExportLedgerEntry>>;
  append(runId: string, entry: ExportLedgerEntry): Promise<void>;
}

/** What planning needs: the clients and the layout; the ledger joins once the batch id is known. */
export interface ExportSources {
  mongo: MongoHandle;
  store: ObjectStore;
  layout: Layout;
}

export interface ExportDeps extends ExportSources {
  ledger: ExportLedger;
}

type Confirm = (question: string) => Promise<void>;

export interface ExportOptions {
  ctx: RunContext;
  mongo: MongoHandle;
  store: ObjectStore;
  collections: CollectionConfig[];
  batchId?: string;
  since?: string;
  cutoff?: string;
  includeRest?: boolean;
  dryRun?: boolean;
  forceUnlock?: boolean;
  confirm?: Confirm;
}

export interface ExportResult {
  batchId: string;
  status: BatchStatus | 'planned';
  outcomes: ChunkOutcome[];
  perCollection: {
    collection: string;
    planned: number;
    done: number;
    flagged: number;
    failed: number;
    docs: number;
  }[];
  exitCode: ExitCode;
}

// Verify
/**
 * A chunk manifest that did not parse: the key, the run id it was listed under, and the record
 * error.
 */
export interface InvalidRecord {
  key: string;
  runId: string;
  id: ChunkRunIdParts;
  message: string;
}

/**
 * `counts` is absent for a record check: a damaged manifest leaves the exporter's counts.json
 * untouched.
 */
export interface ChunkCheck {
  runId: string;
  batchId: string;
  collection: string;
  ok: boolean;
  lines: number;
  errors: string[];
  counts?: CountsRecord;
  parseCheck: ParseCheckRecord;
  operational?: string;
}

export interface VerifyOptions {
  ctx: RunContext;
  store: ObjectStore;
  collections: CollectionConfig[];
  batchIds?: string[];
  /**
   * `-C` was given: the batch completeness check is skipped, since a narrowed selection cannot be
   * counted against `completed_chunks`.
   */
  narrowed?: boolean;
  all?: boolean;
  write?: boolean;
  dryRun?: boolean;
  forceUnlock?: boolean;
  confirm?: Confirm;
}

/**
 * `missing`: batches whose chunk manifests fall short of `completed_chunks`; `invalidBatches`:
 * batch manifests that did not parse (export cannot resume those).
 */
export interface VerifyResult {
  checks: ChunkCheck[];
  skipped: number;
  missing: string[];
  invalidBatches: string[];
  exitCode: ExitCode;
}

// Mapping, transform, infer
export type JsonObject = { [key: string]: unknown };

/**
 * `members`: the literals of an ENUM or SET column; `collation` is `binary` for BINARY, VARBINARY
 * and BLOB columns.
 */
export interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
  hasDefault: boolean;
  autoIncrement: boolean;
  collation: string | null;
  charLength: number | null;
  octetLength: number | null;
  precision: number | null;
  scale: number | null;
  fsp: number | null;
  members: string[] | null;
}

/**
 * `indexedColumns`: the leading column of every index, unique or not; `prefix`: the index covers
 * only the first N characters of a column.
 */
export interface TableInfo {
  name: string;
  columns: Map<string, ColumnInfo>;
  uniqueKeys: { name: string; columns: string[]; prefix: boolean }[];
  primaryKey: string[];
  primaryKeyPrefix: boolean;
  indexedColumns: string[];
}

export interface CastSpec {
  cast: Cast | 'key-objectId' | 'key-string' | 'key-bigint';
  fsp?: number;
  timezone?: string;
  round?: 'reject' | 'half-up';
} // limits from ColumnInfo

export type CastResult = { ok: true; value: unknown } | { ok: false; reason: string };

export interface TransformContext {
  mapping: Mapping;
  table: TableInfo;
  children: Map<string, TableInfo>;
  loadRunId: string;
  ledgerId: number;
}

export type TransformResult =
  | {
      kind: 'row';
      key: string;
      values: unknown[];
      children: Map<string, unknown[][]>;
      castErrors: number;
    }
  | { kind: 'reject'; lineNo: number; reason: string; text: string };

export type RowResult = Extract<TransformResult, { kind: 'row' }>;
export type RejectResult = Extract<TransformResult, { kind: 'reject' }>;

export interface PathStats {
  path: string;
  present: number;
  nulls: number;
  types: Record<string, number>;
  maxChars: number;
  maxBytes: number;
  maxIntDigits: number;
  maxScale: number;
  arrayOfObjects: boolean;
  elements: PathStats[] | null;
}

export interface CastChoice {
  cast: Cast | null;
  sqlType: string | null;
  note: string;
  review: string | null;
  round?: 'half-up';
}

export interface BuildMappingOptions {
  table: string;
  keyColumn: string;
  runIdColumn: string | null;
  chunkColumn: string | null;
  extraColumn: string | null;
  timezone: string;
  childTables: boolean;
  sampled: number;
  minPresence: number;
  maxColumns: number;
  toolVersion: string;
  now: Date;
}

export interface InferOptions {
  ctx: RunContext;
  store: ObjectStore;
  collections: CollectionConfig[];
  batchId?: string;
  outDir: string;
  force?: boolean;
  build: Omit<BuildMappingOptions, 'table' | 'sampled' | 'toolVersion' | 'now'> & {
    table?: string;
  };
}

export interface InferResult {
  files: string[];
  review: { collection: string; lines: string[] }[];
  exitCode: ExitCode;
}

// MySQL and load
export interface MysqlHandle {
  pool: Pool;
  maxAllowedPacket: number;
  version: string;
  connect(): Promise<Connection>;
  close(): Promise<void>;
} // connect: dedicated, outside the pool

/**
 * `created`: the tables the `ddl` statements create, in the same order, so nothing has to be parsed
 * back out of SQL.
 */
export interface ShapeReport {
  problems: string[];
  warnings: string[];
  ddl: string[];
  created: string[];
}

export interface ShapeOptions {
  /** `load.keyLedger`: the 760-character key rule only applies while keys are recorded. */
  keyLedger: boolean;
  /**
   * The run id the load will write, so a `runIdColumn` too narrow for it is a problem before any
   * row is sent.
   */
  loadRunId?: string;
  /**
   * `load.concurrency`: an unindexed child `parentColumn` is a problem (deadlocks) above 1, a
   * warning at 1.
   */
  concurrency?: number;
  /**
   * `mysql.sessionTimeZone`: a TIMESTAMP column reads the cast's wall clock in it, so a cast zone
   * with another offset is flagged.
   */
  sessionTimeZone?: string;
  /** The instant the cast zone's offset is taken at (zones with DST shift); the run's clock. */
  now?: Date;
}

export interface LedgerRow {
  id: number;
  target_table: string;
  collection: string;
  batch_id: string;
  chunk_run_id: string;
  batch_cutoff_utc: string | null;
  manifest_key: string;
  manifest_sha256: string;
  mapping_sha256: string;
  exported_count: number;
  lines_done: number;
  rows_inserted: number;
  rows_updated: number;
  duplicates_skipped: number;
  rows_rejected: number;
  cast_errors: number;
  status: 'loading' | 'loaded' | 'failed';
  attempts: number;
  load_run_id: string;
  error: string | null;
  finished_at: string | null;
}

export interface LoadCandidate {
  resolved: ResolvedManifest;
  reload: boolean;
}

export interface SkippedChunk {
  resolved: ResolvedManifest;
  reason: string;
  severity: 'info' | 'warn' | 'incomplete';
}

export interface LoadTarget {
  loaded: LoadedMapping;
  table: TableInfo;
  children: Map<string, TableInfo>;
  columns: string[];
}

/**
 * One batch of the load plan: its id and the batch manifest's `cutoff_utc`, null without a
 * manifest.
 */
export interface LoadBatchRef {
  id: string;
  cutoff: string | null;
}

/**
 * What the plan decided for one batch: the chunks to load and the ones skipped, each with its
 * reason and severity.
 */
export interface LoadSelection {
  batch: LoadBatchRef;
  candidates: LoadCandidate[];
  skipped: SkippedChunk[];
}

/**
 * The GET_LOCK holder of one target table: a dedicated connection, the lock's name and a release
 * that ends both.
 */
/**
 * `destroy`: the lock is lost (a stalled or dropped connection); the socket is torn down so nothing
 * queues behind the dead command, and `release` then sends nothing.
 */
export interface TableLock {
  conn: Connection;
  name: string;
  release(): Promise<void>;
  destroy(): void;
}

export interface LoadRun {
  ctx: RunContext;
  store: ObjectStore;
  mysql: MysqlHandle;
  loadRunId: string;
  maxBatchBytes: number; // one transaction's byte budget
  maxRowBytes: number; // the largest single row one packet can carry
  targets: Map<string, LoadTarget>; // by collection
  locks: Map<string, TableLock>; // by table
  // batch id to the batch manifest's cutoff_utc; null without a manifest (written to the ledger's
  // batch_cutoff_utc)
  batchCutoffs: ReadonlyMap<string, string | null>;
}

/**
 * `childTuples[i]`: row i's formatted child rows per child table, formatted once by `loadChunk`, so
 * the batch budget and `writeBatch` share them.
 */
export interface LoadBatch {
  rows: RowResult[];
  rejects: RejectResult[];
  toLine: number;
  tuples: string[];
  rejectTuples: string[];
  childTuples: Map<string, string[]>[];
}

export interface BatchTally {
  inserted: number;
  updated: number;
  duplicates: number;
  rejected: number;
  castErrors: number;
}

/**
 * `children`: a row's child tuples per child table, formatted once by the caller; they count toward
 * the batch budget and the packet limit.
 */
export interface Batcher {
  add(
    item: TransformResult,
    tuple: string,
    lineNo: number,
    children?: ReadonlyMap<string, string[]>
  ): LoadBatch | null;
  drain(): LoadBatch | null;
} // tuple: row or reject tuple

export interface BatcherOptions {
  maxRows: number;
  maxBytes: number;
  maxRowBytes: number;
  fixedBytes: number;
  rejectTuple: (reject: RejectResult) => string;
}

export interface SelectOptions {
  allowMismatch: boolean;
  allowUnverified: boolean;
  reload: boolean;
}

export interface LoadOptions {
  ctx: RunContext;
  store: ObjectStore;
  mysql: MysqlHandle;
  collections: CollectionConfig[];
  batchIds?: string[];
  createTables?: boolean;
  allowMismatch?: boolean;
  allowUnverified?: boolean;
  allowOlder?: boolean;
  reload?: boolean;
  dryRun?: boolean;
  forceUnlock?: boolean;
  loadRunId?: string;
  confirm?: Confirm;
}

export interface LoadResult {
  loadRunId: string;
  outcomes: ChunkOutcome[];
  exitCode: ExitCode;
  perTable: {
    table: string;
    chunks: number;
    inserted: number;
    updated: number;
    duplicates: number;
    rejected: number;
  }[];
}

// Reconcile
export type DriftKind =
  | 'not_loaded'
  | 'load_incomplete'
  | 'manifest_changed'
  | 'line_count'
  | 'batch_incomplete'
  | 'table_count'
  | 'chunk_count'
  | 'orphan_chunk'
  | 'missing_rows'
  | 'unknown_rows'
  | 'deep_distinct';

export interface Drift {
  table: string;
  kind: DriftKind;
  chunk: string | null;
  expected: number | null;
  actual: number | null;
  detail: string;
}

export interface ReconcileRun {
  ctx: RunContext;
  store: ObjectStore;
  layout: Layout;
  mysql: MysqlHandle;
}

/** What `tableCheck` proves from MySQL alone. */
export interface TableCheckResult {
  drifts: Drift[];
  /**
   * Rows whose key column is set (loaded by some batch or importer) and rows where it is NULL (the
   * application's).
   */
  keyed: number;
  untracked: number;
  /**
   * `keyed` minus the keys the selected chunks account for: other batches or an earlier importer.
   */
  foreign: number;
  /**
   * Distinct keys the selected chunks wrote per the key ledger, and how many of them have a row;
   * null without the key ledger.
   */
  expected: number | null;
  actual: number | null;
  /**
   * Selected chunks that wrote rows but have no key rows (loaded while `load.keyLedger` was off):
   * their coverage is unproven.
   */
  unproven: string[];
}

export interface ReconcileOptions {
  ctx: RunContext;
  store: ObjectStore;
  mysql: MysqlHandle;
  collections: CollectionConfig[];
  batchIds?: string[];
  /** `-C` was given: a named collection without a mapping is then a config error, not a skip. */
  narrowed?: boolean;
  deep?: boolean;
  showOk?: boolean;
  ignore?: DriftKind[];
  forceUnlock?: boolean;
  confirm?: Confirm;
}

export interface ReconcileResult {
  drifts: Drift[];
  exitCode: ExitCode;
  perTable: {
    table: string;
    chunks: number;
    keyed: number;
    untracked: number;
    foreign: number;
    rejected: number;
    castErrors: number;
    deep: boolean;
  }[];
}

// CLI
export interface ClientNeeds {
  mongo?: boolean;
  s3?: boolean;
  mysql?: boolean;
}

export interface CliContext {
  ctx: RunContext;
  collections: CollectionConfig[];
  mongo?: MongoHandle;
  store?: ObjectStore;
  mysql?: MysqlHandle;
  globals: {
    config: string;
    collections?: string;
    json?: boolean;
    logFormat: 'text' | 'json';
    yes?: boolean;
    forceUnlock?: boolean;
  };
  close(): Promise<void>;
}
