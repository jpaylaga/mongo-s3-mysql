import defaultConfigPath from '#cli/defaultConfigPath';

export interface NextGlobals {
  config?: string;
  collections?: string;
}

/**
 * A `next:` hint the reader can paste: the full command line, with the `-c <path>` and `-C <names>`
 * this run was given, so `mongo-s3-mysql -c prod.json export` is never followed by a `verify`
 * against the default config.
 */
export default function nextCommand(
  globals: NextGlobals,
  subcommand: string,
  args: string[] = []
): string {
  const parts = ['mongo-s3-mysql'];

  if (globals.config !== undefined && globals.config !== defaultConfigPath)
    parts.push('-c', globals.config);

  if (globals.collections !== undefined) parts.push('-C', globals.collections);

  parts.push(subcommand, ...args);

  return parts.join(' ');
}
