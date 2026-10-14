import { ObjectId } from 'mongodb';
import { describe, expect, it } from 'vitest';
import restGapTerm from '../../../src/export/restGapTerm.js';

describe('restGapTerm', () => {
  it('starts a day after the later of the batch start and the attempt start', () => {
    const startedAt = new Date('2026-10-13T02:00:00Z');
    expect(restGapTerm({ key: 'created_at', kind: 'date', startedAt }, new Date('2026-10-13T01:00:00Z'))).toEqual({ created_at: { $gte: new Date('2026-10-14T02:00:00Z') } });
    expect(restGapTerm({ key: 'created_at', kind: 'date', startedAt }, new Date('2026-10-15T09:30:00Z'))).toEqual({ created_at: { $gte: new Date('2026-10-16T09:30:00Z') } });
    const oid = restGapTerm({ key: '_id', kind: 'objectId', startedAt }, new Date('2026-10-15T09:30:00Z'));
    expect((oid._id as { $gte: ObjectId }).$gte.getTimestamp().toISOString()).toBe('2026-10-16T09:30:00.000Z');
  });
});
