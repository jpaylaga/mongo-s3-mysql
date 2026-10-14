import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import isObject from '../ejson/isObject.js';
import type { Config } from '../types.js';
import configSchema from './configSchema.js';

/** Keys that would hold a secret, checked before zod so the message names the env var instead of "unknown key". */
const forbidden: { path: string[]; env: string }[] = [
  { path: ['mongo', 'uri'], env: 'mongo.uriEnv (MSM_MONGO_URI)' }, { path: ['mongo', 'url'], env: 'mongo.uriEnv (MSM_MONGO_URI)' },
  { path: ['mongo', 'password'], env: 'mongo.uriEnv (MSM_MONGO_URI)' },
  { path: ['mysql', 'password'], env: 'mysql.passwordEnv (MSM_MYSQL_PASSWORD)' }, { path: ['mysql', 'url'], env: 'mysql.passwordEnv (MSM_MYSQL_PASSWORD)' },
  { path: ['mysql', 'uri'], env: 'mysql.passwordEnv (MSM_MYSQL_PASSWORD)' },
  { path: ['s3', 'accessKeyId'], env: 'the AWS credential chain (AWS_ACCESS_KEY_ID)' }, { path: ['s3', 'secretAccessKey'], env: 'the AWS credential chain (AWS_SECRET_ACCESS_KEY)' },
  { path: ['s3', 'sessionToken'], env: 'the AWS credential chain (AWS_SESSION_TOKEN)' }, { path: ['s3', 'credentials'], env: 'the AWS credential chain' },
];

function secretsGuard(input: unknown, source: string): void {
  if (!isObject(input)) return;
  const fail = (what: string, env: string) => { throw new Error(`Invalid config ${source}:\n${what} must not be in the config; use ${env}`); };
  for (const { path, env } of forbidden) {
    const section = input[path[0] as string];
    if (isObject(section) && Object.hasOwn(section, path[1] as string)) fail(path.join('.'), env);
  }
  const s3 = input.s3;
  if (isObject(s3) && typeof s3.endpoint === 'string') {
    let url: URL | null = null;
    try { url = new URL(s3.endpoint); } catch { /* zod reports the invalid URL */ }
    if (url && (url.username || url.password)) fail('s3.endpoint userinfo', 'the AWS credential chain');
  }
  const walk = (value: unknown, trail: string[]): void => {
    if (!isObject(value)) return;
    for (const [key, v] of Object.entries(value)) {
      if (/password|secret|token|credential/i.test(key) && !key.endsWith('Env')) fail([...trail, key].join('.'), 'an environment variable named by the matching *Env key');
      walk(v, [...trail, key]);
    }
  };
  walk(input, []);
}

/** Validates a parsed config object; relative paths resolve against `baseDir` (the config file's directory). */
export default function parseConfig(input: unknown, baseDir: string, source = 'config'): Config {
  secretsGuard(input, source);
  const result = configSchema.safeParse(input);
  if (!result.success) throw new Error(`Invalid config ${source}:\n${z.prettifyError(result.error)}`);
  const config = result.data;
  const abs = (p: string) => (isAbsolute(p) ? p : resolve(baseDir, p));
  config.stateDir = abs(config.stateDir);
  config.tempDir = config.tempDir === undefined ? join(config.stateDir, 'tmp') : abs(config.tempDir);
  config.mappingsDir = abs(config.mappingsDir);
  if (config.mysql?.caFile !== undefined) config.mysql.caFile = abs(config.mysql.caFile);
  for (const c of config.collections) if (c.mapping !== undefined) c.mapping = abs(c.mapping);
  return config;
}
