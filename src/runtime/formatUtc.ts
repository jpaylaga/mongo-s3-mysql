/**
 * The three timestamp styles the real records use, all at second precision: `compact`
 * 20260302T000000Z (run ids), `offset` 2026-03-02T00:00:00+00:00 (manifests), `z`
 * 2026-03-02T00:00:00Z (batch cutoffs).
 */
export default function formatUtc(date: Date, style: 'compact' | 'offset' | 'z'): string {
  if (Number.isNaN(date.getTime())) throw new RangeError('formatUtc: invalid date');

  const iso = date.toISOString().slice(0, 19);

  if (style === 'compact') return `${iso.replace(/[-:]/g, '')}Z`;

  return style === 'offset' ? `${iso}+00:00` : `${iso}Z`;
}
