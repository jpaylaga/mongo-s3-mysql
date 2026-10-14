import type { Mapping } from '#types';

/**
 * The VALUES column order of one row: key, mapped columns in mapping order, then the provenance
 * columns that are set.
 */
export default function valueColumns(mapping: Mapping): string[] {
  return [
    mapping.key.column,
    ...mapping.columns.map(c => c.column),
    ...[mapping.runIdColumn, mapping.chunkColumn, mapping.extraColumn].filter(
      (c): c is string => c !== null
    ),
  ];
}
