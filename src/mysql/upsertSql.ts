import quoteId from './quoteId.js';

/**
 * The two fixed halves of the batch upsert; the caller joins its formatted tuples between them.
 * `columns` is the VALUES column order; the key is prepended when it is not already listed. Every column but
 * the key is updated from the row alias, so a re-run rewrites the same rows and never touches unmapped columns.
 * The alias must differ from the table name (MySQL 1066), so a table that takes the usual one gets the other.
 */
export default function upsertSql(name: string, columns: readonly string[], keyColumn: string): { head: string; tail: string } {
  const alias = name.toLowerCase() === '_msm_new' ? '_msm_new2' : '_msm_new';
  const all = columns.includes(keyColumn) ? [...columns] : [keyColumn, ...columns];
  const updates = all.filter((c) => c !== keyColumn).map((c) => `${quoteId(c)} = ${quoteId(alias)}.${quoteId(c)}`);
  // MySQL needs at least one assignment; assigning the key to itself changes nothing.
  if (updates.length === 0) updates.push(`${quoteId(keyColumn)} = ${quoteId(name)}.${quoteId(keyColumn)}`);
  return {
    head: `INSERT INTO ${quoteId(name)} (${all.map(quoteId).join(',')}) VALUES `,
    tail: ` AS ${quoteId(alias)} ON DUPLICATE KEY UPDATE ${updates.join(', ')}`,
  };
}
