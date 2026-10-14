/**
 * `_msm_load_rejects.line_text` is TEXT: this many UTF-8 bytes of a rejected line or tuple are
 * kept.
 */
const maxRejectBytes = 16_384;

/** The longest prefix of `text` that fits `limit` UTF-8 bytes, cut at a character boundary. */
export default function clipBytes(text: string, limit: number = maxRejectBytes): string {
  if (Buffer.byteLength(text, 'utf8') <= limit) return text;

  let bytes = 0;
  let end = 0;

  for (const ch of text) {
    const size = Buffer.byteLength(ch, 'utf8');

    if (bytes + size > limit) break;

    bytes += size;
    end += ch.length;
  }

  return text.slice(0, end);
}
