const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Masks every secret value, then any URI userinfo left over. Longest secrets go first so a password that
 * is a substring of the connection string cannot survive inside the masked remainder.
 */
export default function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  const sorted = [...new Set(secrets.filter((s) => s.length > 0))].sort((a, b) => b.length - a.length);
  for (const secret of sorted) {
    out = out.replace(new RegExp(escapeRe(secret), 'g'), '***');
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) out = out.replace(new RegExp(escapeRe(encoded), 'g'), '***');
  }
  return out.replace(/(\w+:\/\/)[^/\s@]+@/g, '$1***@');
}
