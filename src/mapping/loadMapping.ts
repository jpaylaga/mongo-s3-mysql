import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import errorMessage from '../runtime/errorMessage.js';
import msmError from '../runtime/msmError.js';
import type { LoadedMapping, Mapping } from '../types.js';
import mappingSchema from './mappingSchema.js';

/**
 * The sha256 the load ledger pins. It hashes the parsed mapping (defaults applied) without `inferred`, `$schema`,
 * any `note` and any `sqlType` (DDL hints that change nothing the load does), so re-running infer, editing a
 * comment or spelling out a default does not force a reload. `fsp`, `timezone` and `round` are optional with
 * implicit defaults (0, UTC, reject), so a spelled-out default is dropped before hashing like an absent one.
 */
function mappingSha256(mapping: Mapping): string {
  const strip = (columns: Mapping['columns']) => columns.map(({ note: _note, sqlType: _sqlType, fsp, timezone, round, ...rest }) => ({
    ...rest,
    ...(fsp === undefined || fsp === 0 ? {} : { fsp }),
    ...(timezone === undefined || timezone === 'UTC' ? {} : { timezone }),
    ...(round === undefined || round === 'reject' ? {} : { round }),
  }));
  const { inferred: _inferred, $schema: _schema, key, ...rest } = mapping;
  const { sqlType: _keyType, ...keyRest } = key;
  const canonical = {
    ...rest,
    key: keyRest,
    columns: strip(mapping.columns),
    children: mapping.children.map((ch) => ({ ...ch, columns: strip(ch.columns) })),
  };
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

/** Reads and validates one mapping file; every rule violation is reported together. */
export default async function loadMapping(path: string): Promise<LoadedMapping> {
  const raw = await readFile(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch (err) {
    throw msmError('config', `Invalid mapping ${path}:\ninvalid JSON: ${errorMessage(err)}`, { cause: err, fatal: true });
  }
  const result = mappingSchema.safeParse(parsed);
  if (!result.success) throw msmError('config', `Invalid mapping ${path}:\n${z.prettifyError(result.error)}`, { fatal: true });
  return { path, mapping: result.data, sha256: mappingSha256(result.data) };
}
