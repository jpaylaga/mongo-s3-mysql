import { join } from 'node:path';
import fileExists from '../runtime/fileExists.js';
import msmError from '../runtime/msmError.js';
import type { CollectionConfig, RunContext } from '../types.js';

/**
 * The mapping file a collection loads and reconciles through: `collections[].mapping` when set, else
 * `<mappingsDir>/<name>.mapping.json`. A configured path that does not exist is a config error; a missing
 * default is reported once and the collection is skipped (null), so load and reconcile word it the same way.
 * With `required` (the collection was named with `-C`) a missing default is a config error too: a typo in the
 * name must not pass as "nothing to do".
 */
export default async function resolveMappingPath(ctx: RunContext, cc: CollectionConfig, required = false): Promise<string | null> {
  const path = cc.mapping ?? join(ctx.config.mappingsDir, `${cc.name}.mapping.json`);
  if (await fileExists(path)) return path;
  if (cc.mapping !== undefined) throw msmError('config', `${cc.name}: configured mapping ${path} does not exist`, { fatal: true });
  if (required) throw msmError('config', `-C ${cc.name}: no mapping at ${path}; run infer first, or check the name`, { fatal: true });
  ctx.emit({ type: 'warn', command: ctx.command, message: `${cc.name}: no mapping at ${path}; skipped (run infer first)` });
  return null;
}
