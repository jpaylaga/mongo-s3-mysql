/** A comma-separated flag value (`-C a,b`, `--batch-id x,y`) as its trimmed, non-empty items. */
export default function parseList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}
