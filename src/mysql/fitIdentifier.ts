import { createHash } from 'node:crypto';

/** MySQL identifiers stop at 64 characters: over that, the first 57 plus a 6-hex sha1 tag keeps two long names distinct. */
export default function fitIdentifier(name: string): string {
  return name.length <= 64 ? name : `${name.slice(0, 57)}_${createHash('sha1').update(name, 'utf8').digest('hex').slice(0, 6)}`;
}
