/**
 * The secret values the running command read (resolveContext records them), so the top-level catch
 * in cli.ts can redact with them even when their env names look innocent: a custom `uriEnv` such as
 * MONGO_CONN never matches the conventional-name scan of `envSecrets`. One process runs one
 * command.
 */
const known = new Set<string>();

const runSecrets = {
  record(values: readonly string[]): void {
    for (const value of values) if (value.length > 0) known.add(value);
  },
  list(): string[] {
    return [...known];
  },
  clear(): void {
    known.clear();
  },
};

export default runSecrets;
