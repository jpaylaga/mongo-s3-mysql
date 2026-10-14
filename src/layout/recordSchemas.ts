import { z } from 'zod';

// Loose objects: the original exporter's extras (`area`, `covered_areas`, `notes`) and the partition fields
// ride along untouched, so a record read from a foreign archive round-trips byte for byte in meaning.

const count = z.number().int().min(0);
const nullableString = z.string().nullable();
const mode = z.enum(['timestamp-window', 'objectid-window', 'full-collection', 'manifest-only']);

// A part name becomes a path segment on disk, so it is one plain file name: no slashes, no `.` or `..`.
const partName = z.string().regex(/^[A-Za-z0-9._-]+$/).refine((n) => n !== '.' && n !== '..', 'a plain file name');
const fileRef = z.looseObject({ name: partName, bytes: count, sha256: z.string().regex(/^[0-9a-f]{64}$/), s3_uri: z.string().min(1) });
const partRef = fileRef.extend({ checksum_s3_uri: nullableString, lines: count });

const filter = z.looseObject({
  mode,
  field: z.string().optional(), start_utc: z.string().optional(), end_utc: z.string().optional(), boundary: z.string().optional(),
  filter: z.string().optional(),
  hint: z.string().nullable().optional(), query: z.record(z.string(), z.unknown()).optional(),
});

const chunkManifest = z.looseObject({
  run_id: z.string().min(1), collection: z.string().min(1), mode, filter,
  format: z.enum(['canonical_extended_jsonl_gzip', 'manifest_only']), count_source: z.string().min(1),
  source_count: count, exported_count: count, counts_match: z.boolean(),
  first_id: nullableString, last_id: nullableString,
  file: fileRef.nullable(), checksum_s3_uri: nullableString,
  started_at: z.string().min(1), completed_at: z.string().min(1),
  schema_version: z.number().int().optional(), tool: z.string().optional(), source_count_after: count.optional(),
  parts: z.array(partRef).min(1).optional(),
});

const plannedCollection = z.looseObject({
  collection: z.string().min(1), mode: z.enum(['timestamp-window', 'objectid-window', 'full-collection']),
  field: nullableString, window: z.enum(['hour', 'day']).nullable(), start_utc: nullableString, rest: z.boolean(),
});

const batchManifest = z.looseObject({
  run_id: z.string().min(1), cutoff_utc: z.string().min(1),
  completed_chunks: count, failed_chunks: count, completed_at: nullableString,
  backup_mode: z.string().optional(), requested_start_utc: z.string().optional(),
  collection_start_utc: z.record(z.string(), z.string()).optional(),
  schema_version: z.number().int().optional(), tool: z.string().optional(),
  status: z.enum(['running', 'complete', 'partial', 'interrupted', 'failed']).optional(), started_at: z.string().optional(),
  plan: z.looseObject({ kind: z.enum(['full', 'delta']), include_rest: z.boolean(), collections: z.array(plannedCollection) }).optional(),
  out_of_range: z.record(z.string(), z.looseObject({ before_start: count, after_cutoff: count, untyped: count.optional() })).optional(),
});

const counts = z.looseObject({
  run_id: z.string().min(1), collection: z.string().min(1), mode, count_source: z.string().min(1),
  source_count: count, exported_count: count, matches: z.boolean(),
  source_count_after: count.optional(), verified_lines: count.optional(),
});

const parseCheck = z.looseObject({
  run_id: z.string().min(1), collection: z.string().min(1), mode,
  gzip_test: z.boolean().nullable(), first_line_parseable: z.boolean().nullable(), first_line_has_id: z.boolean().nullable(),
  manifest_only: z.boolean(),
  ok: z.boolean().optional(), lines: count.optional(), parse_errors: count.optional(), missing_ids: count.optional(),
  bytes_ok: z.boolean().nullable().optional(), sha256_ok: z.boolean().nullable().optional(), sidecar_ok: z.boolean().nullable().optional(),
  manifest_sha256: z.string().optional(), verified_at: z.string().optional(), errors: z.array(z.string()).optional(), tool: z.string().optional(),
});

const recordSchemas = { chunkManifest, batchManifest, counts, parseCheck };

export default recordSchemas;
