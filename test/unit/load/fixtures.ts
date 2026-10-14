import chunkRunId from '#layout/chunkRunId';
import mappingSchema from '#mapping/mappingSchema';
import valueColumns from '#mapping/valueColumns';
import type {
  ChunkManifest,
  LedgerRow,
  LoadedMapping,
  LoadTarget,
  Mapping,
  ParseCheckRecord,
  ResolvedManifest,
  TableInfo,
  TransformResult,
  Window,
} from '#types';
import { col, table } from '../mysql/fakeTables.js';

export type Row = Extract<TransformResult, { kind: 'row' }>;
export type Reject = Extract<TransformResult, { kind: 'reject' }>;

export const batchId = 'app-archive-full-20261013T020304Z';

export const day = (d: string): Window => ({
  start: new Date(`${d}T00:00:00Z`),
  end: new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000),
});

export const defaultRunId = chunkRunId(batchId, 'audit_log', 'timestamp-window', day('2026-03-02'));
export const manifestSha = 'a'.repeat(64);
export const mappingSha = 'b'.repeat(64);

/**
 * A ledger row as readLedger returns it (numbers already converted), loaded in full unless
 * overridden.
 */
export function ledgerRow(over: Partial<LedgerRow> = {}): LedgerRow {
  const exported = over.exported_count ?? 100;

  return {
    id: 1,
    target_table: 'audit_log_entries',
    collection: 'audit_log',
    batch_id: batchId,
    chunk_run_id: defaultRunId,
    batch_cutoff_utc: '2026-10-13T01:00:00Z',
    manifest_key: `mongo-archive/manifests/x/collection=audit_log/run_id=${defaultRunId}.json`,
    manifest_sha256: manifestSha,
    mapping_sha256: mappingSha,
    exported_count: exported,
    lines_done: exported,
    rows_inserted: exported,
    rows_updated: 0,
    duplicates_skipped: 0,
    rows_rejected: 0,
    cast_errors: 0,
    status: 'loaded',
    attempts: 1,
    load_run_id: 'load-20261013T040000Z',
    error: null,
    finished_at: '2026-10-13 04:05:00.000',
    ...over,
  };
}

/**
 * A resolved chunk manifest with what selectChunks reads; `parts` and the body are irrelevant to
 * selection.
 */
export function resolved(
  over: Omit<Partial<ResolvedManifest>, 'manifest'> & { manifest?: Partial<ChunkManifest> } = {}
): ResolvedManifest {
  const { manifest: patch, ...rest } = over;
  const runId = rest.runId ?? defaultRunId;

  const manifest: ChunkManifest = {
    run_id: runId,
    collection: 'audit_log',
    mode: 'timestamp-window',
    filter: {
      mode: 'timestamp-window',
      field: 'created_at',
      start_utc: '2026-03-02T00:00:00+00:00',
      end_utc: '2026-03-03T00:00:00+00:00',
      boundary: '[start,end)',
    },
    format: 'canonical_extended_jsonl_gzip',
    count_source: 'countDocuments',
    source_count: 100,
    exported_count: 100,
    counts_match: true,
    first_id: null,
    last_id: null,
    file: null,
    checksum_s3_uri: null,
    started_at: '2026-10-13T02:10:11+00:00',
    completed_at: '2026-10-13T02:10:16+00:00',
    ...(patch ?? {}),
  };

  return {
    key: `mongo-archive/manifests/x/collection=audit_log/run_id=${runId}.json`,
    sha256: manifestSha,
    text: '{}',
    batchId,
    collection: 'audit_log',
    runId,
    id: { mode: 'timestamp-window', window: day('2026-03-02'), tail: 'window' },
    parts: [],
    ...rest,
    manifest,
  };
}

/** A parse-check that proves `resolved` unless overridden: `ok` for the exact manifest body. */
export function parseCheck(
  r: ResolvedManifest,
  over: Partial<ParseCheckRecord> = {}
): ParseCheckRecord {
  return {
    run_id: r.runId,
    collection: r.collection,
    mode: r.manifest.mode,
    gzip_test: true,
    first_line_parseable: true,
    first_line_has_id: true,
    manifest_only: false,
    ok: true,
    manifest_sha256: r.sha256,
    ...over,
  };
}

/** The smallest useful mapping: an ObjectId key beside a surrogate id and one int column. */
export const simpleMappingJson = {
  collection: 'audit_log',
  table: 'audit_log_entries',
  key: { column: 'source_mongo_id', cast: 'objectId' },
  columns: [{ column: 'n', source: 'n', cast: 'int' }],
};

export const simpleMapping = (): Mapping => mappingSchema.parse(simpleMappingJson);

export function simpleTable(): TableInfo {
  return table(
    'audit_log_entries',
    [
      col('id', 'bigint unsigned', {
        nullable: false,
        autoIncrement: true,
        precision: 20,
        scale: 0,
      }),
      col('source_mongo_id', 'char', {
        collation: 'utf8mb4_0900_ai_ci',
        charLength: 24,
        octetLength: 96,
      }),
      col('n', 'int', { precision: 10, scale: 0 }),
    ],
    {
      primaryKey: ['id'],
      uniqueKeys: [{ name: 'uq_ale_source_mongo_id', columns: ['source_mongo_id'] }],
      indexedColumns: ['id', 'source_mongo_id'],
    }
  );
}

export function target(
  mapping: Mapping,
  parent: TableInfo,
  children: Map<string, TableInfo> = new Map(),
  sha256 = mappingSha
): LoadTarget {
  const loaded: LoadedMapping = {
    path: `/work/mappings/${mapping.collection}.mapping.json`,
    mapping,
    sha256,
  };

  return { loaded, table: parent, children, columns: valueColumns(mapping) };
}

export const row = (key: string, values: unknown[] = [key, 1], extra: Partial<Row> = {}): Row => ({
  kind: 'row',
  key,
  values,
  children: new Map(),
  castErrors: 0,
  ...extra,
});

export const reject = (
  lineNo: number,
  reason = 'invalid JSON: bad',
  text = '{ broken'
): Reject => ({ kind: 'reject', lineNo, reason, text });

/** The information_schema rows readTableInfo expects for `simpleTable`, keyed by table name. */
export const simpleSchemaRows = {
  columns: [
    {
      COLUMN_NAME: 'id',
      DATA_TYPE: 'bigint',
      COLUMN_TYPE: 'bigint unsigned',
      IS_NULLABLE: 'NO',
      COLUMN_DEFAULT: null,
      EXTRA: 'auto_increment',
      COLLATION_NAME: null,
      CHARACTER_MAXIMUM_LENGTH: null,
      CHARACTER_OCTET_LENGTH: null,
      NUMERIC_PRECISION: '20',
      NUMERIC_SCALE: '0',
      DATETIME_PRECISION: null,
    },
    {
      COLUMN_NAME: 'source_mongo_id',
      DATA_TYPE: 'char',
      COLUMN_TYPE: 'char(24)',
      IS_NULLABLE: 'YES',
      COLUMN_DEFAULT: null,
      EXTRA: '',
      COLLATION_NAME: 'utf8mb4_0900_ai_ci',
      CHARACTER_MAXIMUM_LENGTH: '24',
      CHARACTER_OCTET_LENGTH: '96',
      NUMERIC_PRECISION: null,
      NUMERIC_SCALE: null,
      DATETIME_PRECISION: null,
    },
    {
      COLUMN_NAME: 'n',
      DATA_TYPE: 'int',
      COLUMN_TYPE: 'int',
      IS_NULLABLE: 'YES',
      COLUMN_DEFAULT: null,
      EXTRA: '',
      COLLATION_NAME: null,
      CHARACTER_MAXIMUM_LENGTH: null,
      CHARACTER_OCTET_LENGTH: null,
      NUMERIC_PRECISION: '10',
      NUMERIC_SCALE: '0',
      DATETIME_PRECISION: null,
    },
  ],
  indexes: [
    { INDEX_NAME: 'PRIMARY', NON_UNIQUE: '0', SEQ_IN_INDEX: '1', COLUMN_NAME: 'id' },
    {
      INDEX_NAME: 'uq_ale_source_mongo_id',
      NON_UNIQUE: '0',
      SEQ_IN_INDEX: '1',
      COLUMN_NAME: 'source_mongo_id',
    },
  ],
};
