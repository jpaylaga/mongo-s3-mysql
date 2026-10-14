import { describe, expect, it } from 'vitest';
import isMsmError from '../../../src/runtime/isMsmError.js';
import msmError from '../../../src/runtime/msmError.js';

describe('isMsmError', () => {
  it('recognises the tool\'s own errors, optionally by code', () => {
    const err = msmError('record', 'bad');
    expect(isMsmError(err)).toBe(true);
    expect(isMsmError(err, 'record')).toBe(true);
    expect(isMsmError(err, 'parse')).toBe(false);
    expect(isMsmError(new Error('plain'))).toBe(false);
    expect(isMsmError(Object.assign(new Error('x'), { msmCode: 7 }))).toBe(false);
    expect(isMsmError(null)).toBe(false);
  });
});
