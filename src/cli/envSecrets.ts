/**
 * Env values that must never appear in output, whether or not this run uses them: everything in a
 * variable whose name suggests a secret, plus the values the caller read itself (a custom `uriEnv`
 * name may not match). resolveContext reads the configured secret names from `process.env` directly
 * and passes them here; the top-level catch in cli.ts (through `fatalMessage`) relies on this scan
 * plus what resolveContext recorded in `runSecrets`.
 */
export default function envSecrets(extra: (string | undefined)[] = []): string[] {
  const fromEnv = Object.entries(process.env)
    .filter(([k]) => /SECRET|TOKEN|PASSWORD|URI/i.test(k))
    .map(([, v]) => v);

  return [...new Set([...fromEnv, ...extra])].filter(
    (v): v is string => typeof v === 'string' && v.length > 0
  );
}
