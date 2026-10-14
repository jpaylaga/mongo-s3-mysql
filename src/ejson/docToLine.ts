import { BSON, type Document } from 'mongodb';
import msmError from '../runtime/msmError.js';

/** What the driver writes for a BSON date outside the JavaScript Date range; it cannot appear inside a string value unescaped. */
const invalidDate = '{"$date":{"$numberLong":"NaN"}}';

/**
 * One document as canonical Extended JSON v2 (no trailing newline; the part writer frames lines). With the
 * driver's promotion turned off, Int32, Double, Long and Decimal128 keep their wrappers, so a load can cast
 * from the exact BSON type instead of guessing from a JS number. A date beyond +/-8.64e15 ms (a "never"
 * sentinel such as Java's Long.MAX_VALUE) deserializes to an Invalid Date; writing it would archive garbage
 * under matching counts, so the line fails loudly instead and the chunk is reported.
 */
export default function docToLine(doc: Document): string {
  const line = BSON.EJSON.stringify(doc, { relaxed: false });
  if (line.includes(invalidDate)) {
    throw msmError('parse', `${BSON.EJSON.stringify({ _id: doc._id }, { relaxed: false })}: a date is outside the JavaScript range (BSON int64 milliseconds beyond +/-8.64e15); fix the value at the source`);
  }
  return line;
}
