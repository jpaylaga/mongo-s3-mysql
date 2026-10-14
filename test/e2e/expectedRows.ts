import { BSON, ObjectId } from 'mongodb';
import type { Document } from 'mongodb';

/** Asia/Manila wall clock, naive, truncated to seconds: what the audit_log mapping writes. */
export function manilaWallClock(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);

  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '00';

  return (
    `${get('year')}-${get('month')}-${get('day')} ` +
    `${get('hour')}:${get('minute')}:${get('second')}`
  );
}

/** UTC wall clock with three fraction digits: what infer's DATETIME(3) columns receive. */
export const utcMillis = (date: Date): string =>
  date.toISOString().replace('T', ' ').replace('Z', '');

/**
 * The raw Extended JSON subtree a `json` column stores, as a comparable value (wrappers verbatim).
 */
export const ejsonTree = (value: unknown): unknown =>
  value === null || value === undefined
    ? null
    : JSON.parse(BSON.EJSON.stringify(value as Document, { relaxed: false }));

const hex = (id: unknown): string | null => (id instanceof ObjectId ? id.toHexString() : null);

const decimal2 = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;

  // Decimal128, Int32 and Long all print their exact value; the twin columns are DECIMAL(n,2).
  return Number(String(value)).toFixed(2);
};

export type Row = Record<string, unknown>;

/**
 * `audit_log_entries` rows the examples/audit_log.mapping.json load must produce, keyed by
 * `source_mongo_id`.
 */
export function expectedAuditRows(docs: Document[], runId: string): Map<string, Row> {
  const rows = new Map<string, Row>();

  for (const doc of docs) {
    const id = hex(doc._id);

    if (id === null) continue;

    rows.set(id, {
      source_mongo_id: id,
      actor_id: doc.actor_id ?? '',
      description: doc.description ?? '',
      data: ejsonTree(doc.data),
      ip_address: doc.ip_address ?? null,
      location: ejsonTree(doc.location),
      created_at: doc.created_at instanceof Date ? manilaWallClock(doc.created_at) : null,
      updated_at: doc.updated_at instanceof Date ? manilaWallClock(doc.updated_at) : null,
      backfill_run_id: runId,
    });
  }

  return rows;
}

/**
 * `orders` and `orders_items` rows the inferred 5.4 mapping must produce; `_msm_chunk` is checked
 * separately.
 */
export function expectedOrderRows(
  docs: Document[],
  runId: string
): { rows: Map<string, Row>; items: Map<string, Row> } {
  const rows = new Map<string, Row>();
  const items = new Map<string, Row>();

  for (const doc of docs) {
    const id = hex(doc._id);

    if (id === null) continue; // legacy-7 is rejected by the objectId key cast

    const consumed = new Set([
      '_id',
      'status',
      'total',
      'sequence',
      'paid',
      'createdAt',
      'customer',
      'tags',
      'items',
    ]);

    const extra = Object.fromEntries(Object.entries(doc).filter(([k]) => !consumed.has(k)));

    rows.set(id, {
      mongo_id: id,
      status: doc.status ?? null,
      total: decimal2(doc.total),
      sequence: doc.sequence === undefined ? null : String(doc.sequence),
      paid: typeof doc.paid === 'boolean' ? (doc.paid ? 1 : 0) : null,
      created_at: doc.createdAt instanceof Date ? utcMillis(doc.createdAt) : null,
      customer: ejsonTree(doc.customer),
      tags: ejsonTree(doc.tags),
      import_run: runId,
      _extra: Object.keys(extra).length === 0 ? null : ejsonTree(extra),
    });

    const list = Array.isArray(doc.items) ? (doc.items as Document[]) : [];

    list.forEach((item, index) => {
      items.set(`${id}:${index}`, {
        order_mongo_id: id,
        item_index: index,
        sku: item.sku ?? null,
        qty: item.qty === undefined ? null : Number(String(item.qty)),
        price: decimal2(item.price),
      });
    });
  }

  return { rows, items };
}

/**
 * A MySQL row as the expected shape: JSON columns parsed (mysql2 may hand them back as text),
 * BigInt-ish strings kept.
 */
export function comparable(row: Row, jsonColumns: string[], keep: string[]): Row {
  const out: Row = {};

  for (const column of keep) {
    const v = row[column];

    out[column] = jsonColumns.includes(column) && typeof v === 'string' ? JSON.parse(v) : v;
  }

  return out;
}
