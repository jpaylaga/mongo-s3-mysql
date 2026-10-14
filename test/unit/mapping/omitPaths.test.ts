import { describe, expect, it } from 'vitest';
import omitPaths from '#mapping/omitPaths';

const doc = () => ({
  _id: { $oid: '69a4d3015a5a5a0001000001' },
  actor_id: 'tenant-a_1010',
  data: { request_input: { page: { $numberInt: '1' }, q: 'status:open' }, response: { ok: true } },
  tags: ['gift', 'repeat'],
  items: [{ sku: 'a' }, { sku: 'b' }],
  created_at: { $date: { $numberLong: '1772409601527' } },
});

describe('omitPaths', () => {
  it('removes top-level and nested paths, leaving the rest', () => {
    const out = omitPaths(doc(), ['_id', 'actor_id', 'data.request_input.page', 'created_at']);

    expect(out).toEqual({
      data: { request_input: { q: 'status:open' }, response: { ok: true } },
      tags: ['gift', 'repeat'],
      items: [{ sku: 'a' }, { sku: 'b' }],
    });
  });

  it('is copy-on-write: untouched subtrees are shared, the input is unchanged', () => {
    const input = doc();
    const out = omitPaths(input, ['data.request_input.q']);

    expect(out).not.toBe(input);
    expect(out.data).not.toBe(input.data);
    expect(out.tags).toBe(input.tags);
    expect(out.items).toBe(input.items);
    expect((out.data as { response: unknown }).response).toBe(input.data.response);
    expect(input.data.request_input.q).toBe('status:open');
  });

  it('returns the same object when nothing matches', () => {
    const input = doc();

    expect(
      omitPaths(input, ['missing', 'data.nope', 'tags.9', 'tags.x', 'created_at.$date', '.'])
    ).toBe(input);
  });

  it('removes array elements by index and leaves wrappers intact', () => {
    const out = omitPaths(doc(), ['items.0', 'tags.1']);

    expect(out.items).toEqual([{ sku: 'b' }]);
    expect(out.tags).toEqual(['gift']);
    expect(omitPaths(doc(), ['items.1.sku']).items).toEqual([{ sku: 'a' }, {}]);

    expect(omitPaths(doc(), ['created_at.$date']).created_at).toEqual({
      $date: { $numberLong: '1772409601527' },
    });
  });

  it('removes several indices of one array against the original positions', () => {
    const input = {
      loc: { type: 'Point', coordinates: [121.0, 14.5, 30] },
      tags: ['a', 'b', 'c', 'd'],
    };

    expect(omitPaths(input, ['loc.coordinates.0', 'loc.coordinates.1'])).toEqual({
      loc: { type: 'Point', coordinates: [30] },
      tags: ['a', 'b', 'c', 'd'],
    });

    expect(omitPaths(input, ['tags.0', 'tags.2', 'loc.type'])).toEqual({
      loc: { coordinates: [121.0, 14.5, 30] },
      tags: ['b', 'd'],
    });

    expect(omitPaths(input, ['tags.3', 'tags.1', 'tags.0'])).toEqual({
      loc: input.loc,
      tags: ['c'],
    });
  });

  it('yields an empty object when every field is consumed', () => {
    expect(omitPaths({ _id: 1, a: 2 }, ['_id', 'a'])).toEqual({});
  });
});
