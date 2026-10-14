import { describe, expect, it } from 'vitest';
import isNoSuchTable from '../../../src/mysql/isNoSuchTable.js';

describe('isNoSuchTable', () => {
  it('is MySQL errno 1146 and nothing else', () => {
    expect(isNoSuchTable(Object.assign(new Error('no'), { errno: 1146 }))).toBe(true);
    expect(isNoSuchTable(Object.assign(new Error('no'), { errno: 1142 }))).toBe(false);
    expect(isNoSuchTable(new Error('no'))).toBe(false);
    expect(isNoSuchTable(null)).toBe(false);
  });
});
