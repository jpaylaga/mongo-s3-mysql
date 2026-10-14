import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import identifier from '../../../src/infer/identifier.js';

describe('identifier', () => {
  it('follows the identifier derivation (docs/mapping.md): camel humps, lowercase, runs to underscore, leading digit, fallbacks and the 64 fit', () => {
    expect(identifier('createdAt')).toBe('created_at');
    expect(identifier('HTTPStatus')).toBe('http_status');
    expect(identifier('Device ID')).toBe('device_id');
    expect(identifier('2fa')).toBe('_2fa');
    expect(identifier('audit-log')).toBe('audit_log');
    expect(identifier('__')).toBe('__');
    expect(identifier('---')).toBe(`f_${createHash('sha1').update('---', 'utf8').digest('hex').slice(0, 6)}`);
    const long = 'a'.repeat(65);
    expect(identifier(long)).toHaveLength(64);
    expect(identifier(long).startsWith(`${'a'.repeat(57)}_`)).toBe(true);
  });
});
