import clipBytes from '../mapping/clipBytes.js';
import type { Batcher, BatcherOptions, LoadBatch, RejectResult } from '../types.js';

/** Bytes a key ledger tuple adds around the key value: parentheses, quotes, a 20-digit chunk id and the comma. */
const keyTupleOverhead = 26;
const comma = 1;

const empty = (): LoadBatch => ({ rows: [], rejects: [], toLine: 0, tuples: [], rejectTuples: [], childTuples: [] });

const bytesOf = (text: string): number => Buffer.byteLength(text, 'utf8');

/**
 * Groups transformed lines into batches that fit one transaction. Rows and rejects both count toward
 * `maxRows`; the byte budget covers the fixed SQL plus every tuple the batch will send (rows, their child
 * rows, rejects and key ledger entries), so the transaction stays near the budget whatever the arrays hold.
 * A batch closes when the next item would overflow it, so `add` returns the previous batch and keeps the
 * item. A row larger than the batch budget but within `maxRowBytes` (the packet) forms a batch of its own;
 * one whose own tuple, or any one child tuple, is larger than the packet cannot be sent at all and becomes a
 * reject, formatted through `rejectTuple` like any other.
 */
export default function createBatcher(options: BatcherOptions): Batcher {
  const { maxRows, maxBytes, maxRowBytes, fixedBytes, rejectTuple } = options;
  let batch = empty();
  let bytes = fixedBytes;
  let count = 0;

  const flush = (): LoadBatch => {
    const out = batch;
    batch = empty();
    bytes = fixedBytes;
    count = 0;
    return out;
  };

  return {
    add(item, tuple, lineNo, children = new Map<string, string[]>()) {
      let entry = item;
      let text = tuple;
      let size = bytesOf(text) + comma;
      if (item.kind === 'row') {
        size += bytesOf(item.key) + keyTupleOverhead;
        let childBytes = 0;
        let oversizedChild = false;
        for (const tuples of children.values()) {
          for (const t of tuples) {
            const n = bytesOf(t) + comma;
            childBytes += n;
            if (fixedBytes + n > maxRowBytes) oversizedChild = true;
          }
        }
        size += childBytes;
        if (fixedBytes + bytesOf(text) + comma > maxRowBytes || oversizedChild) {
          const reject: RejectResult = { kind: 'reject', lineNo, reason: oversizedChild ? 'child row larger than max_allowed_packet' : 'row larger than max_allowed_packet', text: clipBytes(tuple) };
          entry = reject;
          text = rejectTuple(reject);
          size = bytesOf(text) + comma;
        }
      }
      const closed = count > 0 && (count + 1 > maxRows || bytes + size > maxBytes) ? flush() : null;
      if (entry.kind === 'row') {
        batch.rows.push(entry);
        batch.tuples.push(text);
        batch.childTuples.push(new Map(children));
      } else {
        batch.rejects.push(entry);
        batch.rejectTuples.push(text);
      }
      batch.toLine = lineNo;
      bytes += size;
      count += 1;
      return closed;
    },
    drain() {
      return count === 0 ? null : flush();
    },
  };
}
