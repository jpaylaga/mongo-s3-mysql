const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);

  if (f === undefined) {
    // h23 so midnight is "00", never "24"; an unknown zone throws RangeError here, which the
    // mapping schema prevents.
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

    formatters.set(timeZone, f);
  }

  return f;
}

/**
 * The wall clock of an instant in `timeZone` as a naive MySQL literal, `YYYY-MM-DD HH:MM:SS[.fff]`
 * with exactly `fsp` fraction digits. The fraction is truncated, not rounded, so a value never
 * spills into the next second the way MySQL's own rounding would.
 */
export default function formatWallClock(ms: number, timeZone: string, fsp: number): string {
  if (!Number.isFinite(ms))
    throw new RangeError('formatWallClock: not a finite epoch millisecond value');

  const parts: Record<string, string> = {};

  for (const p of formatterFor(timeZone).formatToParts(new Date(ms))) parts[p.type] = p.value;

  const year = (parts.year ?? '').padStart(4, '0');
  const base = `${year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;

  if (fsp <= 0) return base;

  const millis = (((ms % 1000) + 1000) % 1000).toString().padStart(3, '0');

  return `${base}.${millis.slice(0, fsp).padEnd(fsp, '0')}`;
}
