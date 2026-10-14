import { describe, expect, it } from 'vitest';
import readPath from '#mapping/readPath';

const doc = {
  _id: { $oid: '69a4d3015a5a5a0001000001' },
  data: { request_input: { page: { $numberInt: '1' }, q: 'status:open' }, response: null },
  tags: ['gift', 'repeat'],
  items: [{ sku: 'SKU-0100', qty: { $numberInt: '1' } }],
  created_at: { $date: { $numberLong: '1772409601527' } },
};

describe('readPath', () => {
  it('reads nested object keys and reports presence separately from null', () => {
    expect(readPath(doc, 'data.request_input.q')).toEqual({ present: true, value: 'status:open' });
    expect(readPath(doc, 'data.response')).toEqual({ present: true, value: null });
    expect(readPath(doc, 'data.missing')).toEqual({ present: false, value: undefined });
    expect(readPath(doc, 'nope.deeper')).toEqual({ present: false, value: undefined });
  });

  it('indexes arrays by numeric segment only', () => {
    expect(readPath(doc, 'tags.1')).toEqual({ present: true, value: 'repeat' });
    expect(readPath(doc, 'tags.2')).toEqual({ present: false, value: undefined });
    expect(readPath(doc, 'tags.first')).toEqual({ present: false, value: undefined });
    expect(readPath(doc, 'items.0.sku')).toEqual({ present: true, value: 'SKU-0100' });
  });

  it('treats a $-wrapper as a leaf', () => {
    expect(readPath(doc, 'created_at')).toEqual({
      present: true,
      value: { $date: { $numberLong: '1772409601527' } },
    });

    expect(readPath(doc, 'created_at.$date')).toEqual({ present: false, value: undefined });
    expect(readPath(doc, 'items.0.qty.$numberInt')).toEqual({ present: false, value: undefined });
    expect(readPath(doc, '_id.$oid')).toEqual({ present: false, value: undefined });
  });

  it('"." is the value itself and scalars have no children', () => {
    expect(readPath(doc, '.')).toEqual({ present: true, value: doc });
    expect(readPath('text', '.')).toEqual({ present: true, value: 'text' });
    expect(readPath('text', 'length')).toEqual({ present: false, value: undefined });
    expect(readPath(null, 'a')).toEqual({ present: false, value: undefined });
  });

  it('reads own keys only', () => {
    expect(readPath({}, 'toString')).toEqual({ present: false, value: undefined });

    expect(readPath({ a: { b: 1 } }, 'a.constructor')).toEqual({
      present: false,
      value: undefined,
    });
  });
});
