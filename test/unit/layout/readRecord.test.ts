import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import readRecord from '../../../src/layout/readRecord.js';
import recordSchemas from '../../../src/layout/recordSchemas.js';
import createMemoryStore from '../../../src/s3/createMemoryStore.js';
import { readFixture } from '../../helpers.js';

describe('readRecord', () => {
  it('returns null for a missing key', async () => {
    expect(await readRecord(createMemoryStore(), 'nope.json', recordSchemas.counts)).toBeNull();
  });

  it('returns the parsed value with the sha256 and text of the exact body', async () => {
    const store = createMemoryStore();
    const text = await readFixture('real-shape/counts.json');
    await store.putText('counts.json', text, 'application/json');
    const record = await readRecord(store, 'counts.json', recordSchemas.counts);
    expect(record?.value.exported_count).toBe(12);
    expect(record?.text).toBe(text);
    expect(record?.sha256).toBe(createHash('sha256').update(text).digest('hex'));
  });

  it('tolerates a BOM and fails invalid JSON or an invalid record with a record error', async () => {
    const store = createMemoryStore();
    await store.putText('bom.json', `﻿${await readFixture('real-shape/counts.json')}`, 'application/json');
    expect((await readRecord(store, 'bom.json', recordSchemas.counts))?.value.matches).toBe(true);
    await store.putText('bad.json', '{ not json', 'application/json');
    await expect(readRecord(store, 'bad.json', recordSchemas.counts)).rejects.toMatchObject({ msmCode: 'record', message: expect.stringContaining('bad.json: invalid JSON') });
    await store.putText('shape.json', '{"run_id": "r"}', 'application/json');
    await expect(readRecord(store, 'shape.json', recordSchemas.counts)).rejects.toMatchObject({ msmCode: 'record', message: expect.stringContaining('invalid record') });
  });
});
