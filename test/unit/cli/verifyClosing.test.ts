import { describe, expect, it } from 'vitest';
import verifyClosing from '../../../src/cli/verifyClosing.js';
import type { ChunkCheck, VerifyResult } from '../../../src/types.js';

const closing = verifyClosing;
const check = (runId: string, batchId: string, ok: boolean, operational?: string): ChunkCheck => ({
  runId, batchId, collection: 'c', ok, lines: 0, errors: ok ? [] : ['x'], operational,
  counts: { run_id: runId, collection: 'c', mode: 'full-collection', count_source: 'countDocuments', source_count: 0, exported_count: 0, matches: true },
  parseCheck: { run_id: runId, collection: 'c', mode: 'full-collection', gzip_test: null, first_line_parseable: null, first_line_has_id: null, manifest_only: false },
});
const result = (checks: ChunkCheck[], missing: string[] = [], invalidBatches: string[] = []): VerifyResult => ({ checks, skipped: 0, missing, invalidBatches, exitCode: 0 });

describe('verifyClosing', () => {
  it('counts damaged chunks and missing batches separately and gives each its own repair', () => {
    const damaged = closing(result([check('b1-c-full-collection-full', 'b1', false), check('b1-c-full-collection-rest', 'b1', false), check('b2-c-full-collection-full', 'b2', true)]), undefined);
    expect(damaged).toBe('2 damaged chunks in 1 batch: restore the objects from bucket versioning, or export those collections again under a new batch id (a committed chunk is never rewritten); the errors are in each parse-check.json');
    const both = closing(result([check('b1-c-full-collection-full', 'b1', false)], ['b2', 'b3']), undefined);
    expect(both).toContain('1 damaged chunks in 1 batch');
    // export takes one batch id, so several missing batches get the template plus the list, never a comma-joined argument.
    expect(both).toContain('2 batches are missing chunk manifests: mongo-s3-mysql export --batch-id <id> for each of b2, b3 rewrites them for a batch this tool wrote');
    expect(closing(result([], ['b1', 'b2', 'b3', 'b4']), undefined)).toContain('mongo-s3-mysql export --batch-id <id> for each of b1, b2, b3, ... rewrites them');
    // Only a missing-manifest batch: no parse-check carries an error, so the hint does not send the reader to one.
    const missingOnly = closing(result([check('b1-c-full-collection-full', 'b1', true)], ['b2']), undefined);
    expect(missingOnly).toBe('1 batch is missing chunk manifests: mongo-s3-mysql export --batch-id b2 rewrites them for a batch this tool wrote; another exporter\'s batch needs a new export');
    expect(closing(result([check('r', 'b', false, 'InternalError')]), undefined)).toBe('mongo-s3-mysql verify again for the chunks that could not be read');
    expect(closing(result([check('r', 'b', true)]), undefined)).toBe('mongo-s3-mysql infer, then mongo-s3-mysql load');
    expect(closing(result([]), true)).toBe('run without --dry-run to read the parts');
    expect(closing({ ...result([]), exitCode: 130 }, undefined)).toBe('mongo-s3-mysql verify again to continue');
    // The hint carries the config and collection flags the run was given, so it can be pasted as is.
    expect(closing(result([check('r', 'b', true)]), undefined, { config: 'prod.json', collections: 'orders' })).toBe('mongo-s3-mysql -c prod.json -C orders infer, then mongo-s3-mysql -c prod.json -C orders load');
    expect(closing(result([], ['b2']), undefined, { config: 'prod.json' })).toContain('mongo-s3-mysql -c prod.json export --batch-id b2 rewrites them');
  });

  it('a damaged batch manifest gets its own hint: export cannot resume it, so only versioning restores it', () => {
    expect(closing(result([], [], ['b1']), undefined)).toBe('batch manifest b1 is damaged: restore it from bucket versioning (export cannot resume a batch whose manifest does not parse)');
    const several = closing(result([], ['b2'], ['b1', 'b3', 'b4', 'b5']), undefined);
    expect(several).toContain('1 batch is missing chunk manifests: mongo-s3-mysql export --batch-id b2 rewrites them');
    expect(several).toContain('batch manifests b1, b3, b4, ... are damaged: restore them from bucket versioning');
  });
});
