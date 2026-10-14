/**
 * MySQL error 1146: the table does not exist, which a ledger reader treats as "nothing loaded yet".
 */
export default function isNoSuchTable(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { errno?: unknown }).errno === 1146;
}
