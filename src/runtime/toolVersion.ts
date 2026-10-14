import { createRequire } from 'node:module';

/**
 * package.json is always installed next to dist; a copy without it is a broken install, so this
 * fails at startup instead of stamping a wrong version into records.
 */
const pkg = createRequire(import.meta.url)('../../package.json') as {
  name: string;
  version: string;
};

/**
 * The `tool` value written into every record, read from package.json so a release bump cannot
 * forget it.
 */
const toolVersion: string = `${pkg.name}@${pkg.version}`;

export default toolVersion;
