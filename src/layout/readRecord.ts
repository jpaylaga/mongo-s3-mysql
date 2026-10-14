import { createHash } from 'node:crypto';
import { z } from 'zod';
import msmError from '../runtime/msmError.js';
import type { ObjectStore } from '../types.js';

/**
 * One JSON record from S3, validated. The sha256 is of the exact object body: that is what the load ledger
 * and parse-check pin, so a rewritten manifest is detected byte for byte, not by its parsed shape.
 */
export default async function readRecord<T>(store: ObjectStore, key: string, schema: z.ZodType<T>): Promise<{ value: T; sha256: string; text: string } | null> {
  const text = await store.getText(key);
  if (text === null) return null;
  const sha256 = createHash('sha256').update(text, 'utf8').digest('hex');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (err) {
    throw msmError('record', `${key}: invalid JSON`, { cause: err });
  }
  const result = schema.safeParse(parsed);
  if (!result.success) throw msmError('record', `${key}: invalid record\n${z.prettifyError(result.error)}`);
  return { value: result.data, sha256, text };
}
