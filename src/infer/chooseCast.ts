import type { CastChoice, PathStats } from '#types';

/**
 * VARCHAR sizes tried in order; 1.5 x the longest sampled value leaves room for what the sample
 * missed.
 */
const varcharSizes = [32, 64, 128, 255, 512, 1024];
const textMaxBytes = 16_000;

/** The widest VARCHAR that fits with headroom, else a TEXT type by the byte length seen. */
function stringType(maxChars: number, maxBytes: number): string {
  const needed = Math.ceil(maxChars * 1.5);
  const size = varcharSizes.find(n => n >= needed);

  if (size !== undefined) return `VARCHAR(${size})`;

  return maxBytes <= textMaxBytes ? 'TEXT' : 'MEDIUMTEXT';
}

/**
 * Evidence for the reviewer: observed types by count, then nulls and absences, like
 * `decimal 58, int 2`.
 */
function evidence(stats: PathStats, sampled: number): string {
  const parts = Object.entries(stats.types)
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => `${type} ${count}`);

  if (stats.nulls > 0) parts.push(`null ${stats.nulls}`);

  if (stats.present < sampled) parts.push(`missing ${sampled - stats.present}`);

  return parts.join(', ');
}

const percent = (ratio: number): string => `${(ratio * 100).toFixed(1)}%`;

/**
 * The cast and SQL type for one field from what the sample showed: wrapper types decide, nulls are
 * ignored, and anything mixed or structured becomes `json` so no value is lost. A field seen in
 * fewer than `minPresence` of the documents gets no column (`cast: null`).
 */
export default function chooseCast(
  stats: PathStats,
  opts: { timezone: string; sampled: number; minPresence: number }
): CastChoice {
  const note = evidence(stats, opts.sampled);
  const presence = opts.sampled > 0 ? stats.present / opts.sampled : 0;

  if (presence < opts.minPresence)
    return {
      cast: null,
      sqlType: null,
      note,
      review: `present in ${percent(presence)} of samples`,
    };

  const types = Object.keys(stats.types);
  const only = (...allowed: string[]) => types.length > 0 && types.every(t => allowed.includes(t));

  if (types.length === 0)
    return { cast: 'json', sqlType: 'JSON', note, review: 'no non-null value in the sample' };

  if (only('objectId')) return { cast: 'objectId', sqlType: 'CHAR(24)', note, review: null };

  if (only('string'))
    return {
      cast: 'string',
      sqlType: stringType(stats.maxChars, stats.maxBytes),
      note,
      review: null,
    };

  if (only('int')) return { cast: 'int', sqlType: 'INT', note, review: null };

  if (only('int', 'long')) return { cast: 'bigint', sqlType: 'BIGINT', note, review: null };

  if (only('int', 'long', 'double'))
    return { cast: 'double', sqlType: 'DOUBLE', note, review: null };

  if (only('int', 'long', 'decimal')) {
    const intDigits = stats.maxIntDigits;

    if (intDigits > 65)
      return {
        cast: 'json',
        sqlType: 'JSON',
        note,
        review: `${intDigits} integer digits exceed DECIMAL(65); kept as json`,
      };

    // The clamp: MySQL allows scale <= 30 and precision <= 65, and the integer digits come first.
    const scale = Math.min(stats.maxScale, 30, 65 - intDigits);
    const precision = Math.min(65, 2 * intDigits + 4 + scale);
    const sqlType = `DECIMAL(${precision},${scale})`;

    if (scale < stats.maxScale) {
      return {
        cast: 'decimal',
        sqlType,
        note,
        review: `scale clamped from ${stats.maxScale} to ${scale}; values are rounded half-up`,
        round: 'half-up',
      };
    }

    return { cast: 'decimal', sqlType, note, review: null };
  }

  if (only('bool')) return { cast: 'bool', sqlType: 'TINYINT(1)', note, review: null };

  if (only('date'))
    return {
      cast: 'datetime',
      sqlType: 'DATETIME(3)',
      note: `${note}, wall clock in ${opts.timezone}`,
      review: null,
    };

  return {
    cast: 'json',
    sqlType: 'JSON',
    note,
    review: types.length > 1 ? `mixed types in the sample (${note}); kept as json` : null,
  };
}
