import { describe, expect, it } from 'vitest';
import redact from '#runtime/redact';

describe('redact', () => {
  it('masks every secret, longest first, and URI userinfo', () => {
    const uri = 'mongodb+srv://app:s3cr3t@cluster.example.net/app';

    expect(redact(`failed ${uri} with s3cr3t`, [uri, 's3cr3t'])).toBe('failed *** with ***');
    expect(redact('mysql://root:pw@h:3306', [])).toBe('mysql://***@h:3306');
    expect(redact('token=abc; next abc', ['abc'])).toBe('token=***; next ***');
  });

  it('masks the url-encoded form and ignores empty secrets', () => {
    expect(redact('p%40ss and p@ss', ['p@ss', ''])).toBe('*** and ***');
    expect(redact('nothing here', [''])).toBe('nothing here');
  });

  it('escapes regex characters in secrets', () => {
    expect(redact('key a.b*c here', ['a.b*c'])).toBe('key *** here');
    expect(redact('aXbYc', ['a.b*c'])).toBe('aXbYc');
  });
});
