import { BSON } from 'mongodb';
import type { Document } from 'mongodb';

/** Canonical Extended JSON of a filter, as the manifest records it (dates and ids as wrappers). */
export default function canonicalFilter(filter: Document): Record<string, unknown> {
  return JSON.parse(BSON.EJSON.stringify(filter, { relaxed: false })) as Record<string, unknown>;
}
