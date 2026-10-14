import { Binary, ObjectId, Timestamp } from 'mongodb';
import type { IdBracket } from '#types';

/**
 * `_id` keyset ranges in BSON comparison order. `$gte: lowest` opens a bracket and MongoDB's type
 * bracketing keeps `$gt: last` inside it, so one `_id` index walk covers every type without a sort
 * across types. Null, MinKey, MaxKey and NaN ids are outside every bracket on purpose.
 */
const idBrackets: IdBracket[] = [
  { name: 'number', types: ['int', 'long', 'double', 'decimal'], lowest: -Infinity },
  { name: 'string', types: ['string', 'symbol'], lowest: '' },
  { name: 'object', types: ['object'], lowest: {} },
  { name: 'binData', types: ['binData'], lowest: new Binary(Buffer.alloc(0), 0) },
  { name: 'objectId', types: ['objectId'], lowest: new ObjectId('000000000000000000000000') },
  { name: 'bool', types: ['bool'], lowest: false },
  { name: 'date', types: ['date'], lowest: new Date(-8.64e15) },
  { name: 'timestamp', types: ['timestamp'], lowest: new Timestamp({ t: 0, i: 0 }) },
];

export default idBrackets;
