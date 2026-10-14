import { z } from 'zod';

/** An IANA time zone the runtime knows; Intl is the only authority available without a zone database. */
const timeZoneSchema = z.string().refine((tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } },
  'an IANA time zone like "UTC" or "Asia/Manila"');

export default timeZoneSchema;
