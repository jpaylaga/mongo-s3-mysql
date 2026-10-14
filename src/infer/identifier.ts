import { createHash } from 'node:crypto';
import fitIdentifier from '../mysql/fitIdentifier.js';

const identifierRe = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Split camel humps, lowercase, every run outside [a-z0-9_] becomes `_`, trim `_`. */
const snake = (name: string): string =>
  name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');

/**
 * The column or table identifier derived from a field or collection name: empty snake falls back to the
 * name itself, a leading digit gets `_`, and a name with nothing usable becomes `f_<6 hex of sha1>`.
 * An explicit `--table` never passes through here: flags are MySQL identifiers verbatim.
 */
export default function identifier(field: string): string {
  let name = snake(field) || field;
  if (/^\d/.test(name)) name = `_${name}`;
  if (!identifierRe.test(name)) name = `f_${createHash('sha1').update(field, 'utf8').digest('hex').slice(0, 6)}`;
  return fitIdentifier(name);
}
