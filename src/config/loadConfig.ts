import { dirname, resolve } from 'node:path';
import parseConfig from '#config/parseConfig';
import readConfigObject from '#config/readConfigObject';
import type { Config } from '#types';

/**
 * The validated config: `readConfigObject` keeps the file text out of the error, `parseConfig`
 * applies the schema and the secrets guard.
 */
export default async function loadConfig(path: string): Promise<Config> {
  return parseConfig(await readConfigObject(path), dirname(resolve(path)), path);
}
