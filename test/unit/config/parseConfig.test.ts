import { describe, expect, it } from 'vitest';
import parseConfig from '../../../src/config/parseConfig.js';
import { exampleConfigJson } from '../../helpers.js';

const base = () => structuredClone(exampleConfigJson) as Record<string, any>;

describe('parseConfig', () => {
  it('resolves relative paths against the config directory and defaults tempDir', () => {
    const c = parseConfig(base(), '/etc/msm');
    expect(c.stateDir).toBe('/etc/msm/.mongo-s3-mysql');
    expect(c.tempDir).toBe('/etc/msm/.mongo-s3-mysql/tmp');
    expect(c.mappingsDir).toBe('/etc/msm/mappings');
    expect(c.mysql?.caFile).toBe('/etc/msm/global-bundle.pem');
  });

  it('keeps absolute paths and resolves collection mappings', () => {
    const input: Record<string, any> = { ...base(), stateDir: '/var/lib/msm', tempDir: '/mnt/scratch' };
    input.collections[0].mapping = 'custom/audit.json';
    const c = parseConfig(input, '/etc/msm');
    expect(c.stateDir).toBe('/var/lib/msm');
    expect(c.tempDir).toBe('/mnt/scratch');
    expect(c.collections[0]?.mapping).toBe('/etc/msm/custom/audit.json');
  });

  it('names the env var when a secret is pasted into the config', () => {
    const withUri = { ...base(), mongo: { database: 'app', uri: 'mongodb://u:p@h/db' } };
    expect(() => parseConfig(withUri, '/x', 'cfg.json')).toThrow(/Invalid config cfg.json:\nmongo.uri must not be in the config; use mongo.uriEnv \(MSM_MONGO_URI\)/);
    const withPassword = { ...base(), mysql: { host: 'h', user: 'u', database: 'd', password: 'p' } };
    expect(() => parseConfig(withPassword, '/x')).toThrow(/mysql\.password .*\(MSM_MYSQL_PASSWORD\)/);
    const withKeys = { ...base(), s3: { bucket: 'b-b-b', secretAccessKey: 'x' } };
    expect(() => parseConfig(withKeys, '/x')).toThrow(/s3\.secretAccessKey .*\(AWS_SECRET_ACCESS_KEY\)/);
    const withUserinfo = { ...base(), s3: { bucket: 'b-b-b', endpoint: 'http://key:secret@127.0.0.1:9090' } };
    expect(() => parseConfig(withUserinfo, '/x')).toThrow(/s3.endpoint userinfo/);
  });

  it('refuses any secret-looking key anywhere except *Env keys', () => {
    const nested = { ...base(), export: { apiToken: 'x' } };
    expect(() => parseConfig(nested, '/x')).toThrow(/export.apiToken must not be in the config/);
    expect(() => parseConfig(base(), '/x')).not.toThrow();
    const envNames = { ...base(), mysql: { host: 'h', user: 'u', database: 'd', passwordEnv: 'DB_PASSWORD' } };
    expect(parseConfig(envNames, '/x').mysql?.passwordEnv).toBe('DB_PASSWORD');
  });

  it('never echoes a secret value in the error', () => {
    const withUri = { ...base(), mongo: { database: 'app', uri: 'mongodb://u:topsecret@h/db' } };
    let message = '';
    try { parseConfig(withUri, '/x'); } catch (err) { message = (err as Error).message; }
    expect(message).not.toContain('topsecret');
  });

  it('reports zod problems with the source name', () => {
    expect(() => parseConfig({ mongo: {}, s3: {} }, '/x', 'cfg.json')).toThrow(/^Invalid config cfg.json:\n/);
  });
});
