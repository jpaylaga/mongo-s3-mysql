import { dirname, resolve } from 'node:path';
import type { Config } from '../types.js';
import parseConfig from './parseConfig.js';
import readConfigObject from './readConfigObject.js';

/** The validated config: `readConfigObject` keeps the file text out of the error, `parseConfig` applies the schema and the secrets guard. */
export default async function loadConfig(path: string): Promise<Config> {
  return parseConfig(await readConfigObject(path), dirname(resolve(path)), path);
}
