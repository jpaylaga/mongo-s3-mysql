import { describe, expect, it } from 'vitest';
import valueColumns from '#mapping/valueColumns';
import { ordersMapping, twinMapping } from '../mysql/fakeTables.js';

describe('valueColumns', () => {
  it('is the key, the mapped columns in order, then the provenance columns that are set', () => {
    expect(valueColumns(twinMapping())).toEqual([
      'source_mongo_id',
      'actor_id',
      'description',
      'data',
      'ip_address',
      'location',
      'created_at',
      'updated_at',
      'backfill_run_id',
    ]);

    expect(valueColumns(ordersMapping())).toEqual([
      'mongo_id',
      'status',
      'total',
      'sequence',
      'paid',
      'created_at',
      'customer',
      'tags',
      'import_run',
      '_msm_chunk',
      '_extra',
    ]);
  });
});
