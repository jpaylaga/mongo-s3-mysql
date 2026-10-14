/**
 * The one shape of a recorded key: `_msm_load_keys.key_value`, the deep check's temporary id table,
 * the key-width rule of the shape check and infer's string-key ladder all derive from it, so the
 * limits cannot drift apart.
 */
const keyLedgerKey = { maxChars: 760, collation: 'utf8mb4_0900_bin' } as const;

export default keyLedgerKey;
