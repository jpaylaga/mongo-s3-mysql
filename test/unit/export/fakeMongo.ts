import type { Collection, Document, MongoClient } from 'mongodb';
import type { ChunkPlan, MongoHandle } from '#types';

export interface Call {
  method: string;
  args: unknown[];
}

export interface FakeCollectionSpec {
  name: string;
  /** Streamed by the unsorted cursor; also the keyset pages when `pages` is not scripted. */
  docs?: Document[];
  /** Keyset pages, consumed in order by `find().toArray()`. */
  pages?: Document[][];
  indexes?: { name: string; key: Document }[];
  /** Answers `findOne` with a sort (findBounds): `min` for ascending, `max` for descending. */
  bounds?: { min: unknown; max: unknown } | null;
  empty?: boolean;
  estimated?: number;
  /** `countDocuments` answers: a scripted sequence, or a function of the filter and hint. */
  counts?: number[] | ((filter: Document, hint: unknown) => number);
  /** Thrown by `countDocuments` when a hint is passed (DocumentDB style refusals). */
  countWithHintError?: Error;
  /** Thrown by the cursor after this many documents. */
  failAfter?: number;
  /**
   * Called with the 0-based index before the cursor yields each document (to abort mid-stream
   * deterministically).
   */
  onDoc?: (index: number) => void;
}

export interface FakeCollection {
  coll: Collection;
  calls: Call[];
  spec: FakeCollectionSpec;
}

/**
 * A scripted stand-in for the driver's `Collection`: just the calls planChunks, exportChunk and the
 * streams make.
 */
export function fakeCollection(spec: FakeCollectionSpec): FakeCollection {
  const calls: Call[] = [];
  const docs = spec.docs ?? [];
  const pages = spec.pages === undefined ? null : [...spec.pages];
  let scripted = Array.isArray(spec.counts) ? [...spec.counts] : null;

  const coll = {
    collectionName: spec.name,
    async findOne(filter: Document, options: Document = {}) {
      calls.push({ method: 'findOne', args: [filter, options] });

      if (options.sort !== undefined) {
        const [field, direction] = Object.entries(options.sort as Document)[0] as [string, number];

        if (spec.bounds === null || spec.bounds === undefined) return null;

        return { _id: 'x', [field]: direction === 1 ? spec.bounds.min : spec.bounds.max };
      }

      return spec.empty ? null : { _id: docs[0]?._id ?? 1 };
    },
    listIndexes() {
      calls.push({ method: 'listIndexes', args: [] });

      return {
        async toArray() {
          return spec.indexes ?? [{ name: '_id_', key: { _id: 1 } }];
        },
      };
    },
    async estimatedDocumentCount() {
      calls.push({ method: 'estimatedDocumentCount', args: [] });

      return spec.estimated ?? docs.length;
    },
    async countDocuments(filter: Document, options: Document = {}) {
      calls.push({ method: 'countDocuments', args: [filter, options] });

      if (options.hint !== undefined && spec.countWithHintError) throw spec.countWithHintError;

      if (scripted !== null) {
        const next = scripted.shift();

        if (next === undefined) {
          scripted = null;

          return docs.length;
        }

        return next;
      }

      if (typeof spec.counts === 'function') return spec.counts(filter, options.hint);

      return docs.length;
    },
    find(filter: Document, options: Document = {}) {
      const call: Call = { method: 'find', args: [filter, options] };

      calls.push(call);

      const cursor = {
        sort(s: unknown) {
          call.args.push({ sort: s });

          return cursor;
        },
        hint(h: unknown) {
          call.args.push({ hint: h });

          return cursor;
        },
        limit(l: number) {
          call.args.push({ limit: l });

          return cursor;
        },
        maxTimeMS(m: number) {
          call.args.push({ maxTimeMS: m });

          return cursor;
        },
        async toArray() {
          return pages === null ? [] : (pages.shift() ?? []);
        },
        async close() {
          calls.push({ method: 'close', args: [] });
        },
        async *[Symbol.asyncIterator]() {
          let seen = 0;

          for (const doc of docs) {
            if (spec.failAfter !== undefined && seen >= spec.failAfter)
              throw Object.assign(new Error('cursor reset'), { code: 'ECONNRESET' });

            spec.onDoc?.(seen);
            seen += 1;
            yield doc;
          }
        },
      };

      return cursor;
    },
  };

  return { coll: coll as unknown as Collection, calls, spec };
}

/** A `MongoHandle` over scripted collections; unknown names get an empty collection. */
export function fakeMongo(
  collections: FakeCollection[]
): MongoHandle & { collections: Map<string, FakeCollection> } {
  const map = new Map(collections.map(c => [c.spec.name, c]));

  const get = (name: string) => {
    let c = map.get(name);

    if (c === undefined) {
      c = fakeCollection({ name, empty: true });
      map.set(name, c);
    }

    return c.coll;
  };

  return {
    client: {} as MongoClient,
    db: { collection: get } as unknown as MongoHandle['db'],
    close: async () => undefined,
    collections: map,
  };
}

/** A keyset full-collection plan over one bracket set, for chunk-level tests. */
export function keysetPlan(
  batchId: string,
  collection: string,
  brackets: ChunkPlan['brackets'],
  rawPrefix: string
): ChunkPlan {
  return {
    collection,
    runId: `${batchId}-${collection}-full-collection-full`,
    mode: 'full-collection',
    tail: 'full',
    filter: {},
    filterRecord: { mode: 'full-collection', filter: 'all documents', hint: '_id_', query: {} },
    hint: '_id_',
    paging: 'keyset',
    brackets,
    rawPrefix,
  };
}
