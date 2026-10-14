import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import loadMapping from '../../../src/mapping/loadMapping.js';
import { tmpDir } from '../../helpers.js';

const minimal = {
  collection: 'audit_log', table: 'audit_log_entries', key: { column: 'source_mongo_id', cast: 'objectId' },
  columns: [{ column: 'actor_id', source: 'actor_id', cast: 'string', note: 'first note' }],
  children: [{ table: 'items', source: 'items', parentColumn: 'p', columns: [{ column: 'sku', source: 'sku', cast: 'string', note: 'child note' }] }],
};

async function write(dir: string, name: string, value: unknown): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value));
  return path;
}

describe('loadMapping', () => {
  it('returns the parsed mapping with defaults and a sha256', async () => {
    const dir = await tmpDir();
    const loaded = await loadMapping(await write(dir, 'a.mapping.json', minimal));
    expect(loaded.mapping.onCastError).toBe('reject');
    expect(loaded.mapping.runIdColumn).toBeNull();
    expect(loaded.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.path).toContain('a.mapping.json');
  });

  it('hashes without notes, inferred and spelled-out defaults', async () => {
    const dir = await tmpDir();
    const a = await loadMapping(await write(dir, 'a.json', minimal));
    const edited = structuredClone(minimal) as Record<string, unknown>;
    (edited.columns as { note?: string }[])[0]!.note = 'another note';
    delete (edited.children as { columns: { note?: string }[] }[])[0]!.columns[0]!.note;
    edited.inferred = { at: '2026-10-13T00:00:00Z', tool: 'mongo-s3-mysql@0.1.0', sampled: 60, review: [] };
    edited.onCastError = 'reject';
    edited.runIdColumn = null;
    const b = await loadMapping(await write(dir, 'b.json', edited));
    expect(b.sha256).toBe(a.sha256);

    const changed = structuredClone(minimal) as Record<string, unknown>;
    changed.onCastError = 'null';
    const c = await loadMapping(await write(dir, 'c.json', changed));
    expect(c.sha256).not.toBe(a.sha256);
  });

  it('hashes without sqlType and $schema, which only shape DDL: a re-run infer --force cannot force a reload', async () => {
    const dir = await tmpDir();
    const base = { collection: 'c', table: 't', key: { column: 'k', cast: 'string', sqlType: 'VARCHAR(64)' }, columns: [{ column: 'a', source: 'a', cast: 'string', sqlType: 'VARCHAR(32)' }] };
    const resized = { $schema: 'https://example.invalid/mapping.json', ...base, key: { ...base.key, sqlType: 'VARCHAR(128)' }, columns: [{ ...base.columns[0], sqlType: 'TEXT' }] };
    await writeFile(join(dir, 'a.json'), JSON.stringify(base));
    await writeFile(join(dir, 'b.json'), JSON.stringify(resized));
    expect((await loadMapping(join(dir, 'a.json'))).sha256).toBe((await loadMapping(join(dir, 'b.json'))).sha256);
    const recast = { ...base, columns: [{ ...base.columns[0], cast: 'json' }] };
    await writeFile(join(dir, 'c.json'), JSON.stringify(recast));
    expect((await loadMapping(join(dir, 'c.json'))).sha256).not.toBe((await loadMapping(join(dir, 'a.json'))).sha256);
  });

  it('hashes a spelled-out fsp 0, timezone UTC or round reject like an absent one, and a real value differently', async () => {
    const dir = await tmpDir();
    const columns = [{ column: 'at', source: 'at', cast: 'datetime' }, { column: 'n', source: 'n', cast: 'decimal' }];
    const base = { collection: 'c', table: 't', key: { column: 'k', cast: 'objectId' }, columns };
    const spelled = { ...base, columns: [{ ...columns[0], fsp: 0, timezone: 'UTC' }, { ...columns[1], round: 'reject' }] };
    const a = await loadMapping(await write(dir, 'a.json', base));
    expect((await loadMapping(await write(dir, 'b.json', spelled))).sha256).toBe(a.sha256);
    expect((await loadMapping(await write(dir, 'c.json', { ...base, columns: [{ ...columns[0], fsp: 3 }, columns[1]] }))).sha256).not.toBe(a.sha256);
    expect((await loadMapping(await write(dir, 'd.json', { ...base, columns: [{ ...columns[0], timezone: 'Asia/Manila' }, columns[1]] }))).sha256).not.toBe(a.sha256);
    expect((await loadMapping(await write(dir, 'e.json', { ...base, columns: [columns[0], { ...columns[1], round: 'half-up' }] }))).sha256).not.toBe(a.sha256);
  });

  it('reports every rule violation under one header', async () => {
    const dir = await tmpDir();
    const bad = { ...minimal, runIdColumn: 'actor_id', columns: [{ column: 'actor_id', source: '_id', cast: 'int', default: 'x' }] };
    const path = await write(dir, 'bad.json', bad);
    await expect(loadMapping(path)).rejects.toMatchObject({ msmCode: 'config', fatal: true, message: expect.stringMatching(new RegExp(`^Invalid mapping ${path}:\\n`)) });
    await expect(loadMapping(path)).rejects.toThrow(/collides[\s\S]*_id[\s\S]*integer/);
  });

  it('rejects invalid JSON with the path and tolerates a BOM', async () => {
    const dir = await tmpDir();
    await expect(loadMapping(await write(dir, 'x.json', '{ not json'))).rejects.toThrow(/Invalid mapping .*x\.json:\ninvalid JSON/);
    const bom = await loadMapping(await write(dir, 'bom.json', `﻿${JSON.stringify(minimal)}`));
    expect(bom.mapping.table).toBe('audit_log_entries');
  });

  it('propagates a missing file', async () => {
    await expect(loadMapping(join(await tmpDir(), 'missing.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
