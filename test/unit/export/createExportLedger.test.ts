import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import createExportLedger from '../../../src/export/createExportLedger.js';
import { tmpDir } from '../../helpers.js';

const sha = 'a'.repeat(64);
const entry = (key: string, exported: number, sha256 = sha) => ({ manifest_key: key, bucket: 'example-archive-bucket', manifest_sha256: sha256, exported_count: exported });

describe('createExportLedger', () => {
  it('reads an empty map when the file does not exist', async () => {
    const ledger = createExportLedger(await tmpDir(), 'batch-1');
    expect((await ledger.read()).size).toBe(0);
  });

  it('appends one JSON line per commit and reads them back', async () => {
    const dir = await tmpDir();
    const ledger = createExportLedger(dir, 'batch-1');
    await ledger.append('batch-1-orders-full-collection-full', entry('m/orders.json', 12));
    await ledger.append('batch-1-coupons-manifest-only-full', entry('m/coupons.json', 0, 'b'.repeat(64)));
    const text = await readFile(join(dir, 'export', 'batch-1', 'completed.jsonl'), 'utf8');
    const lines = text.trimEnd().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ run_id: 'batch-1-orders-full-collection-full', manifest_key: 'm/orders.json', bucket: 'example-archive-bucket', manifest_sha256: sha, exported_count: 12, counts_match: true });
    expect(typeof lines[0]?.at).toBe('string');
    const read = await ledger.read();
    expect(read.get('batch-1-orders-full-collection-full')).toEqual(entry('m/orders.json', 12));
    expect(read.get('batch-1-coupons-manifest-only-full')?.exported_count).toBe(0);
  });

  it('skips a torn last line, lines without the expected fields, older lines without a key, and flagged lines', async () => {
    const dir = await tmpDir();
    await mkdir(join(dir, 'export', 'b'), { recursive: true });
    const good = JSON.stringify({ run_id: 'b-c-full-collection-full', ...entry('m/c.json', 3), counts_match: true, at: 'x' });
    // A cache written before the key, bucket and counts_match fields existed cannot prove a commit for the current layout.
    const old = JSON.stringify({ run_id: 'b-d-full-collection-full', manifest_sha256: sha, exported_count: 3, at: 'x' });
    const flagged = JSON.stringify({ run_id: 'b-e-full-collection-full', ...entry('m/e.json', 3), counts_match: false, at: 'x' });
    await writeFile(join(dir, 'export', 'b', 'completed.jsonl'), `${good}\n${old}\n${flagged}\n{"run_id":"nope"}\n{"run_id":"b-c-full-col`);
    const read = await createExportLedger(dir, 'b').read();
    expect([...read.keys()]).toEqual(['b-c-full-collection-full']);
  });
});
