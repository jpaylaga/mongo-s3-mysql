import { describe, expect, it } from 'vitest';
import mappingSchema from '../../../src/mapping/mappingSchema.js';
import mappingToDdl from '../../../src/mapping/mappingToDdl.js';
import { ordersMapping } from '../mysql/fakeTables.js';

/** The expected DDL groups several columns per line; only the tokens matter. */
const norm = (sql: string) => sql.replace(/\s+/g, ' ').trim();

const expectedOrders = `CREATE TABLE IF NOT EXISTS \`orders\` (
  \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  \`status\` VARCHAR(32) NULL, \`total\` DECIMAL(14,2) NULL, \`sequence\` BIGINT NULL, \`paid\` TINYINT(1) NULL,
  \`created_at\` DATETIME(3) NULL, \`customer\` JSON NULL, \`tags\` JSON NULL,
  \`mongo_id\` CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NULL,
  \`import_run\` VARCHAR(64) NULL, \`_msm_chunk\` BIGINT UNSIGNED NULL, \`_extra\` JSON NULL,
  PRIMARY KEY (\`id\`), UNIQUE KEY \`uq_orders_mongo_id\` (\`mongo_id\`), KEY \`ix_orders__msm_chunk\` (\`_msm_chunk\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;`;

const expectedItems = `CREATE TABLE IF NOT EXISTS \`orders_items\` (
  \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  \`order_mongo_id\` CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, \`item_index\` INT UNSIGNED NOT NULL,
  \`sku\` VARCHAR(32) NULL, \`qty\` INT NULL, \`price\` DECIMAL(10,2) NULL,
  PRIMARY KEY (\`id\`), UNIQUE KEY \`uq_orders_items_parent\` (\`order_mongo_id\`, \`item_index\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;`;

describe('mappingToDdl', () => {
  it('emits the documented DDL for the orders mapping', () => {
    const [orders, items, ...rest] = mappingToDdl(ordersMapping());
    expect(rest).toEqual([]);
    expect(norm(orders as string)).toBe(norm(expectedOrders));
    expect(norm(items as string)).toBe(norm(expectedItems));
  });

  it('uses the per-cast defaults without sqlType and the key cast types', () => {
    const m = mappingSchema.parse({
      collection: 'c', table: 't', key: { column: 'k', cast: 'string' }, columns: [
        { column: 's', source: 's', cast: 'string' }, { column: 'i', source: 'i', cast: 'int' }, { column: 'b', source: 'b', cast: 'bigint' },
        { column: 'd', source: 'd', cast: 'double' }, { column: 'n', source: 'n', cast: 'decimal' }, { column: 'f', source: 'f', cast: 'bool' },
        { column: 't', source: 't', cast: 'datetime', fsp: 6 }, { column: 'u', source: 'u', cast: 'datetime' },
        { column: 'o', source: 'o', cast: 'objectId' }, { column: 'j', source: 'j', cast: 'json' },
      ],
    });
    const [sql] = mappingToDdl(m);
    expect(sql).toContain('`s` VARCHAR(255) NULL');
    expect(sql).toContain('`i` INT NULL');
    expect(sql).toContain('`b` BIGINT NULL');
    expect(sql).toContain('`d` DOUBLE NULL');
    expect(sql).toContain('`n` DECIMAL(65,30) NULL');
    expect(sql).toContain('`f` TINYINT(1) NULL');
    expect(sql).toContain('`t` DATETIME(6) NULL');
    expect(sql).toContain('`u` DATETIME(0) NULL');
    expect(sql).toContain('`o` CHAR(24) NULL');
    expect(sql).toContain('`j` JSON NULL');
    expect(sql).toContain('`k` VARCHAR(255) COLLATE utf8mb4_0900_bin NULL');
    expect(sql).not.toContain('KEY `ix_');
    const bigKey = mappingToDdl(mappingSchema.parse({ collection: 'c', table: 't', key: { column: 'k', cast: 'bigint' } }))[0];
    expect(bigKey).toContain('`k` BIGINT NULL');
    expect(bigKey).toContain('UNIQUE KEY `uq_t_k` (`k`)');
  });

  it('a VARBINARY string key gets no COLLATE clause, and a CHAR or BINARY one is refused before any table exists', () => {
    const key = (sqlType: string) => mappingSchema.parse({ collection: 'c', table: 't', key: { column: 'k', cast: 'string', sqlType },
      children: [{ table: 'u', source: 'u', parentColumn: 'p', columns: [{ column: 'v', source: 'v', cast: 'int' }] }] });
    const [parent, child] = mappingToDdl(key('VARBINARY(255)'));
    expect(parent).toContain('`k` VARBINARY(255) NULL');
    expect(parent).not.toContain('VARBINARY(255) COLLATE');
    expect(child).toContain('`p` VARBINARY(255) NOT NULL');
    expect(mappingToDdl(key('varchar(64)'))[0]).toContain('`k` varchar(64) COLLATE utf8mb4_0900_bin NULL');
    expect(() => mappingToDdl(key('CHAR(36)'))).toThrow(/a string key needs VARCHAR or VARBINARY, not CHAR \(key\.sqlType CHAR\(36\)\)/);
    expect(() => mappingToDdl(key('BINARY(16)'))).toThrow(/not BINARY/);
    expect(() => mappingToDdl(key('TEXT'))).toThrow(/not TEXT/);
  });

  it('with the key ledger on, a string key wider than the ledger stores is refused before any table exists', () => {
    const key = (sqlType: string) => mappingSchema.parse({ collection: 'c', table: 't', key: { column: 'k', cast: 'string', sqlType },
      children: [{ table: 'u', source: 'u', parentColumn: 'p', columns: [{ column: 'v', source: 'v', cast: 'int' }] }] });
    const tooWide = /mapping c: key\.sqlType VARBINARY\(1000\) holds 1000 characters, more than the 760 the key ledger stores; shorten it or set load\.keyLedger false/;
    expect(() => mappingToDdl(key('VARBINARY(1000)'), { keyLedger: true })).toThrow(tooWide);
    // 761..768 characters still fit InnoDB's utf8mb4 index limit, so only the ledger rule can refuse them.
    expect(() => mappingToDdl(key('VARCHAR(761)'), { keyLedger: true })).toThrow(/holds 761 characters, more than the 760/);
    expect(() => mappingToDdl(key('varchar(800)'), { keyLedger: true })).toThrow(/holds 800 characters/);
    expect(mappingToDdl(key('VARCHAR(760)'), { keyLedger: true })[0]).toContain('`k` VARCHAR(760) COLLATE utf8mb4_0900_bin NULL');
    // Without the ledger nothing stores the key; without the option (infer's .sql for a config that never loads) the width is the caller's.
    expect(mappingToDdl(key('VARBINARY(1000)'), { keyLedger: false })[0]).toContain('`k` VARBINARY(1000) NULL');
    expect(mappingToDdl(key('VARBINARY(1000)'))[0]).toContain('`k` VARBINARY(1000) NULL');
    // An ObjectId or bigint key is never recorded wider than the ledger, whatever its declared type.
    expect(mappingToDdl(mappingSchema.parse({ collection: 'c', table: 't', key: { column: 'k', cast: 'bigint', sqlType: 'DECIMAL(65,0)' } }), { keyLedger: true })[0]).toContain('`k` DECIMAL(65,0) NULL');
  });

  it('makes a key named id the primary key with no surrogate', () => {
    const [sql] = mappingToDdl(mappingSchema.parse({ collection: 'c', table: 't', key: { column: 'id', cast: 'bigint' } }));
    expect(sql).toContain('`id` BIGINT NOT NULL');
    expect(sql).toContain('PRIMARY KEY (`id`)');
    expect(sql).not.toContain('AUTO_INCREMENT');
    expect(sql).not.toContain('UNIQUE KEY');
  });

  it('refuses a mapped column named id that is not the key', () => {
    const m = mappingSchema.parse({ collection: 'c', table: 't', key: { column: 'k' }, columns: [{ column: 'ID', source: 'legacy_id', cast: 'int' }] });
    expect(() => mappingToDdl(m)).toThrow(/column "ID" is reserved for the surrogate id/);
    const extra = mappingSchema.parse({ collection: 'c', table: 't', key: { column: 'k' }, extraColumn: 'id' });
    expect(() => mappingToDdl(extra)).toThrow(/reserved for the surrogate id/);
    const child = mappingSchema.parse({ collection: 'c', table: 't', key: { column: 'k' },
      children: [{ table: 'u', source: 'u', parentColumn: 'p', columns: [{ column: 'id', source: 'id', cast: 'int' }] }] });
    expect(() => mappingToDdl(child)).toThrow(/child u column "id" is reserved/);
  });

  it('refuses a child parentColumn or indexColumn named id, which the surrogate id already takes', () => {
    const base = ordersMapping();
    const parent = { ...base, children: [{ ...base.children[0]!, parentColumn: 'id' }] };
    expect(() => mappingToDdl(parent)).toThrow(/child orders_items column "id" is reserved for the surrogate id/);
    const index = { ...base, children: [{ ...base.children[0]!, indexColumn: 'ID' }] };
    expect(() => mappingToDdl(index)).toThrow(/child orders_items column "ID" is reserved/);
  });

  it('indexes a child without indexColumn non-uniquely and shortens long index names', () => {
    const longTable = `t${'x'.repeat(62)}`;
    const m = mappingSchema.parse({ collection: 'c', table: longTable, key: { column: 'k' }, chunkColumn: 'chunk',
      children: [{ table: 'u', source: 'u', parentColumn: 'p', columns: [{ column: 'v', source: 'v', cast: 'int' }] }] });
    const [parent, child] = mappingToDdl(m);
    const names = [...(parent as string).matchAll(/KEY `([^`]+)`/g)].map((x) => x[1] as string);
    expect(names).toHaveLength(2);
    for (const n of names) {
      expect(n.length).toBe(64);
      expect(n).toMatch(/^(uq|ix)_t?x+_[0-9a-f]{6}$/);
    }
    expect(child).toContain('KEY `ix_u_parent` (`p`)');
    expect(child).not.toContain('UNIQUE KEY');
    expect(child).not.toContain('INT UNSIGNED NOT NULL,\n  `v`');
  });
});
