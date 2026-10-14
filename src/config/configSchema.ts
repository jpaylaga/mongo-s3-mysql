import { z } from 'zod';
import instantSchema from './instantSchema.js';

const envName = z.string().regex(/^[A-Z_][A-Z0-9_]*$/);
const int = (min: number, max: number, dflt: number) => z.number().int().min(min).max(max).default(dflt);
const segmentValue = z.string().regex(/^[A-Za-z0-9._-]+$/, 'letters, digits, dot, underscore, hyphen');
/** Collection names are plain-object keys in the batch manifest, so the prototype names are refused next to `system.*`. */
const collectionName = z.string().regex(/^[A-Za-z0-9_.-]{1,120}$/).refine((n) => !n.startsWith('system.') && !['__proto__', 'constructor', 'prototype'].includes(n));
/** Every key the tool itself writes into a chunk or batch manifest; a partition key with one of these names would be overwritten. */
const reservedRecordKeys = [
  'run_id', 'collection', 'mode', 'filter', 'format', 'file', 'parts', 'notes', 'tool',
  'count_source', 'source_count', 'exported_count', 'counts_match', 'source_count_after', 'first_id', 'last_id', 'checksum_s3_uri',
  'started_at', 'completed_at', 'schema_version', 'cutoff_utc', 'backup_mode', 'requested_start_utc', 'collection_start_utc',
  'completed_chunks', 'failed_chunks', 'status', 'out_of_range', 'plan',
];

const collection = z.strictObject({
  name: collectionName,
  strategy: z.enum(['timestamp-window', 'objectid-window', 'full-collection']).optional(), // export only
  field: z.string().regex(/^[^$.][^$]*$/).optional(),        // timestamp-window: indexed date field
  window: z.enum(['hour', 'day']).default('day'),
  start: instantSchema.optional(),                             // first window; default: observed minimum
  rest: z.enum(['auto', 'export', 'skip']).default('auto'),    // the rest chunk; auto: full batches, <= 1,000,000 docs
  mapping: z.string().optional(),                              // default <mappingsDir>/<name>.mapping.json
}).superRefine((c, ctx) => {
  if (c.strategy === 'timestamp-window' && !c.field) ctx.addIssue({ code: 'custom', path: ['field'], message: 'required for timestamp-window' });
  if (c.strategy !== 'timestamp-window' && c.field) ctx.addIssue({ code: 'custom', path: ['field'], message: 'only for timestamp-window' });
});

const configSchema = z.strictObject({
  $schema: z.string().optional(),
  mongo: z.strictObject({
    uriEnv: envName.default('MSM_MONGO_URI'), database: z.string().min(1),
    readPreference: z.enum(['primary', 'primaryPreferred', 'secondary', 'secondaryPreferred', 'nearest']).default('secondaryPreferred'),
    batchSize: int(10, 100_000, 1000), maxTimeMs: z.number().int().positive().default(1_800_000),
  }),
  s3: z.strictObject({
    bucket: z.string().min(3).max(63),
    prefix: z.string().regex(/^[A-Za-z0-9!_.*'()=/-]*$/).default('').transform((p) => p.replace(/^\/+|\/+$/g, '')),
    /** Ordered key=value segments between raw|manifests|validation and collection=; key order is path order. */
    partition: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), segmentValue).default({})
      .refine((p) => Object.keys(p).every((k) => !reservedRecordKeys.includes(k)), 'partition key clashes with a record key'),
    region: z.string().min(1).optional(), endpoint: z.url().optional(), forcePathStyle: z.boolean().default(false),
    storageClass: z.enum(['STANDARD', 'STANDARD_IA', 'INTELLIGENT_TIERING', 'GLACIER_IR']).default('STANDARD'),
    sse: z.enum(['none', 'AES256', 'aws:kms']).default('none'), kmsKeyId: z.string().min(1).optional(),
    partSizeMb: int(5, 512, 16), queueSize: int(1, 16, 4),
  }),
  mysql: z.strictObject({
    host: z.string().min(1), port: int(1, 65_535, 3306), user: z.string().min(1),
    passwordEnv: envName.default('MSM_MYSQL_PASSWORD'), database: z.string().min(1).max(64),
    tls: z.enum(['on', 'off']).default('on'), caFile: z.string().min(1).optional(),
    /** Session time_zone; TIMESTAMP columns read wall-clock strings in it: use the application's connection time_zone. MySQL accepts -13:59 to +14:00. */
    sessionTimeZone: z.string().regex(/^[+-]\d{2}:\d{2}$/, 'like +08:00').refine((tz) => {
      const [h, m] = [Number(tz.slice(1, 3)), Number(tz.slice(4, 6))];
      return m < 60 && (tz.startsWith('+') ? h * 60 + m <= 14 * 60 : h * 60 + m <= 13 * 60 + 59);
    }, 'MySQL accepts -13:59 to +14:00').default('+00:00'),
    connectTimeoutMs: z.number().int().positive().default(10_000),
  }).optional(),
  stateDir: z.string().min(1).default('.mongo-s3-mysql'),
  tempDir: z.string().min(1).optional(),                       // default <stateDir>/tmp
  mappingsDir: z.string().min(1).default('mappings'),
  minFreeDiskMb: z.number().int().min(0).default(2048),
  retry: z.strictObject({ attempts: int(1, 50, 8), baseDelayMs: z.number().int().positive().default(500),
    maxDelayMs: z.number().int().positive().default(60_000) }).prefault({}),
  export: z.strictObject({
    batchPrefix: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/).default('mongo-s3-mysql'),
    concurrency: int(1, 64, 4), partMaxDocs: z.number().int().min(1).default(5_000_000),
    partMaxBytesMb: int(1, 8192, 1024),                        // uncompressed
    keysetPageDocs: int(1, 100_000, 10_000), gzipLevel: int(1, 9, 6), chunkAttempts: int(1, 20, 3),
    safetyLagMinutes: z.number().int().min(0).default(60), deltaOverlapMinutes: z.number().int().min(0).default(60),
    notes: z.string().max(500).optional(),
  }).prefault({}),
  verify: z.strictObject({ concurrency: int(1, 64, 8) }).prefault({}),
  infer: z.strictObject({ sampleSize: int(1, 1_000_000, 10_000), maxParts: int(1, 10_000, 50),
    minPresence: z.number().min(0).max(1).default(0.01), maxColumns: int(1, 1000, 200) }).prefault({}),
  load: z.strictObject({
    concurrency: int(1, 64, 4), batchRows: int(1, 100_000, 1000), batchMaxBytesMb: int(1, 256, 8), chunkAttempts: int(1, 20, 3),
    keyLedger: z.boolean().default(true),                       // record each chunk's keys in _msm_load_keys
  }).prefault({}),
  collections: z.array(collection).default([])
    .refine((c) => new Set(c.map((x) => x.name)).size === c.length, 'collection names must be unique'),
}).superRefine((c, ctx) => {
  if (c.s3.sse === 'aws:kms' && !c.s3.kmsKeyId) ctx.addIssue({ code: 'custom', path: ['s3', 'kmsKeyId'], message: 'required when sse is aws:kms' });
  if (c.retry.maxDelayMs < c.retry.baseDelayMs) ctx.addIssue({ code: 'custom', path: ['retry', 'maxDelayMs'], message: 'must be >= baseDelayMs' });
});

export default configSchema;
