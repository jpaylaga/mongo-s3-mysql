/**
 * The message of anything thrown: an Error's own, else the value as text. Redaction is the caller's
 * job where the text is printed or persisted.
 */
export default function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
