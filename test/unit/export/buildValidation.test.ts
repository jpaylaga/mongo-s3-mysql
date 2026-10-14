import { describe, expect, it } from 'vitest';
import buildValidation from '#export/buildValidation';
import recordSchemas from '#layout/recordSchemas';
import type { ChunkManifest } from '#types';
import { realShape } from '../../helpers.js';

describe('buildValidation', () => {
  it('derives counts.json and parse-check.json from the manifest and the first line', async () => {
    const manifest = {
      ...((await realShape('chunk-timestamp-window.json')) as ChunkManifest),
      source_count_after: 12,
    };

    const { counts, parseCheck } = buildValidation(
      manifest,
      '{ "_id" : { "$oid" : "69a4d3015a5a5a0001000001" }, "a" : 1 }',
      true
    );

    expect(counts).toEqual({
      run_id: manifest.run_id,
      collection: 'audit_log',
      mode: 'timestamp-window',
      count_source: 'countDocuments',
      source_count: 12,
      exported_count: 12,
      matches: true,
      source_count_after: 12,
    });

    expect(parseCheck).toEqual({
      run_id: manifest.run_id,
      collection: 'audit_log',
      mode: 'timestamp-window',
      gzip_test: true,
      first_line_parseable: true,
      first_line_has_id: true,
      manifest_only: false,
    });

    expect(recordSchemas.counts.safeParse(counts).success).toBe(true);
    expect(recordSchemas.parseCheck.safeParse(parseCheck).success).toBe(true);
  });

  it('leaves booleans null for manifest-only or empty chunks, flags a bad first line', async () => {
    const only = (await realShape('chunk-manifest-only.json')) as ChunkManifest;
    const { counts, parseCheck } = buildValidation(only, null, null);

    expect(counts.source_count_after).toBeUndefined();

    expect(parseCheck).toMatchObject({
      gzip_test: null,
      first_line_parseable: null,
      first_line_has_id: null,
      manifest_only: true,
    });

    const full = (await realShape('chunk-full-collection.json')) as ChunkManifest;

    // A line that is not JSON cannot be judged for an _id: null, as verify records it too, so both
    // parse-checks agree.
    expect(buildValidation(full, '{ not json', true).parseCheck).toMatchObject({
      first_line_parseable: false,
      first_line_has_id: null,
    });

    expect(buildValidation(full, '[1]', true).parseCheck).toMatchObject({
      first_line_parseable: true,
      first_line_has_id: false,
    });

    expect(buildValidation(full, '{"a":1}', true).parseCheck).toMatchObject({
      first_line_parseable: true,
      first_line_has_id: false,
    });
  });
});
