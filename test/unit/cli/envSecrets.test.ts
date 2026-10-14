import { afterEach, describe, expect, it, vi } from 'vitest';
import envSecrets from '../../../src/cli/envSecrets.js';

describe('envSecrets', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('collects the values of conventionally named variables, drops empty ones and ignores the rest', () => {
    vi.stubEnv('MSM_TEST_SECRET', 'alpha');
    vi.stubEnv('MSM_TEST_API_TOKEN', 'beta');
    vi.stubEnv('MSM_TEST_DB_PASSWORD', 'gamma');
    vi.stubEnv('MSM_TEST_MONGO_URI', 'mongodb://h/app');
    vi.stubEnv('MSM_TEST_EMPTY_TOKEN', '');
    vi.stubEnv('MSM_TEST_PLAIN', 'delta');
    const found = envSecrets();
    expect(found).toEqual(expect.arrayContaining(['alpha', 'beta', 'gamma', 'mongodb://h/app']));
    expect(found).not.toContain('delta');
    expect(found).not.toContain('');
  });

  it('adds the extra values the caller read itself, once each, and drops undefined and empty extras', () => {
    vi.stubEnv('MSM_TEST_SECRET', 'alpha');
    const found = envSecrets(['custom-value', undefined, '', 'alpha', 'custom-value']);
    expect(found.filter((v) => v === 'custom-value')).toHaveLength(1);
    expect(found.filter((v) => v === 'alpha')).toHaveLength(1);
    expect(found).not.toContain('');
    expect(found.every((v) => typeof v === 'string' && v.length > 0)).toBe(true);
  });
});
