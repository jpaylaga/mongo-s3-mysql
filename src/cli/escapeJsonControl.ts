/**
 * JSON.stringify escapes the C0 controls but leaves DEL and the C1 range (U+007F..U+009F) raw, which a terminal
 * reading `--json` or `--log-format json` output would still execute. Inside JSON they can only sit in string
 * literals, so a `\\u00XX` escape keeps the document valid.
 */
export default function escapeJsonControl(json: string): string {
  return json.replace(/[\u007f-\u009f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
