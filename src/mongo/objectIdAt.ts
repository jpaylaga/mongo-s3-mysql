import { ObjectId } from 'mongodb';

/**
 * The lowest ObjectId whose embedded time is `date` (seconds since the epoch), the boundary value
 * of an ObjectId window.
 */
export default function objectIdAt(date: Date): ObjectId {
  return ObjectId.createFromTime(Math.floor(date.getTime() / 1000));
}
