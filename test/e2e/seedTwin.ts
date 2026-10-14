import { readFile } from 'node:fs/promises';
import { BSON, Double, MongoClient, ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { fixturePath } from '../helpers.js';
import { database } from './startStack.js';

/** The three UTC days the audit_log twin covers; the delta step works against the last one. */
export const auditDays = ['2026-03-02', '2026-03-03', '2026-03-04'] as const;
export const auditPerDay = 100;
/**
 * Position (0-based, within its day) of the document seeded without `created_at`; it lands in the
 * rest chunk.
 */
export const fieldlessAudit = { day: 1, k: 50 };
/**
 * Every 50th document (by global counter) drops `actor_id` or carries `description: null`, so the
 * mapping's `""` defaults reach the NOT NULL twin columns.
 */
export const missingActorEvery = { modulo: 50, remainder: 7 };
export const nullDescriptionEvery = { modulo: 50, remainder: 13 };

let seed = 20261013;

const rnd = (): number => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;

  return seed / 0x7fffffff;
};

const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)] as T;

/**
 * An ObjectId timed at `ms` with a fixed machine part and a counter, so ids never collide across
 * days.
 */
export const objectIdAt = (ms: number, counter: number): ObjectId =>
  new ObjectId(
    `${Math.floor(ms / 1000)
      .toString(16)
      .padStart(8, '0')}5a5a5a0001${counter.toString(16).padStart(6, '0')}`
  );

/**
 * `created_at` of document k of a day: 100 documents spread over the day, the last one at 23:45:36.
 */
export const auditCreatedAt = (day: string, k: number): Date =>
  new Date(Date.parse(`${day}T00:00:00Z`) + k * 864_000 + 527);

/**
 * Document k of `day` with the global counter n (ids and ip addresses derive from it);
 * `withCreatedAt: false` makes the rest-chunk document.
 */
export function auditDocument(day: string, k: number, n: number, withCreatedAt = true): Document {
  const createdAt = auditCreatedAt(day, k);
  const roll = rnd();
  const actorId = `tenant-${pick(['a', 'b'])}_${1010 + (n % 23)}`;

  const doc: Document = {
    _id: objectIdAt(createdAt.getTime(), n + 1),
    ...(n % missingActorEvery.modulo === missingActorEvery.remainder ? {} : { actor_id: actorId }),
    description:
      n % nullDescriptionEvery.modulo === nullDescriptionEvery.remainder
        ? null
        : `User ${String.fromCharCode(65 + (n % 26))}-${String(k).padStart(2, '0')} ` +
          `visited https://app.example.com/orders/${1000 + n}`,
    data: {
      request_input:
        roll < 0.95
          ? {
              page: new BSON.Int32(1 + (n % 9)),
              q: pick(['status:open', 'status:paid', 'tenant:all']),
            }
          : roll < 0.99
            ? []
            : null,
      response: n % 2 === 0 ? { ok: true, took_ms: new BSON.Int32(5 + (n % 40)) } : null,
    },
    ip_address: `10.${n % 4}.${(n * 7) % 256}.${17 + (n % 200)}`,
    location:
      rnd() < 0.014
        ? { lat: new Double(14.5995 + (n % 10) / 100), lng: new Double(120.9842 - (n % 10) / 100) }
        : null,
    updated_at: new Date(createdAt.getTime() + 1000),
  };

  if (withCreatedAt) doc.created_at = createdAt;

  return doc;
}

/** The 60 orders fixture lines (59 ObjectIds plus `legacy-7`) as driver documents, types intact. */
export async function orderDocuments(): Promise<Document[]> {
  const text = await readFile(fixturePath('orders.sample.jsonl'), 'utf8');

  return text
    .split('\n')
    .filter(Boolean)
    .map(line => BSON.EJSON.parse(line, { relaxed: false }) as Document);
}

/**
 * Seeds the twin of a real migration: 300 audit_log documents over three UTC days with an index on
 * created_at and one document without it, the 60 orders of the fixture, and an empty coupons
 * collection. Returns the document count per collection.
 */
export default async function seedTwin(mongoUri: string): Promise<Record<string, number>> {
  const client = new MongoClient(mongoUri);

  await client.connect();

  try {
    const db = client.db(database);

    await db.dropDatabase();

    const audit: Document[] = [];

    auditDays.forEach((day, d) => {
      for (let k = 0; k < auditPerDay; k += 1)
        audit.push(
          auditDocument(
            day,
            k,
            d * auditPerDay + k,
            !(d === fieldlessAudit.day && k === fieldlessAudit.k)
          )
        );
    });

    await db.collection('audit_log').insertMany(audit);
    await db.collection('audit_log').createIndex({ created_at: 1 }, { name: 'created_at_1' });

    const orders = await orderDocuments();

    await db.collection('orders').insertMany(orders);
    await db.createCollection('coupons');

    return { audit_log: audit.length, orders: orders.length, coupons: 0 };
  } finally {
    await client.close();
  }
}
