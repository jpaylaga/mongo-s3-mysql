import { z } from 'zod';

/**
 * An ISO 8601 instant with an explicit offset and no fraction: without the offset `new Date` would
 * read the host zone, and sub-second values would differ from the second-precision instants the
 * plan freezes.
 */
const instantSchema = z.iso.datetime({ offset: true, precision: 0 });

export default instantSchema;
