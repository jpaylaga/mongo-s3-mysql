import { describe, expect, it } from 'vitest';
import checkShape from '#mysql/checkTableShape';
import type { Mapping, ShapeOptions, TableInfo } from '#types';
import { col, ordersMapping, ordersTables, table, twinMapping, twinTable } from './fakeTables.js';

const checkTableShape = (
  mapping: Mapping,
  tables: ReadonlyMap<string, TableInfo | null>,
  options: ShapeOptions = { keyLedger: true }
) => checkShape(mapping, tables, options);

const tablesOf = (...tables: (TableInfo | [string, null])[]) =>
  new Map<string, TableInfo | null>(tables.map(t => (Array.isArray(t) ? t : [t.name, t])));

const withColumn = (t: TableInfo, c: ReturnType<typeof col>): TableInfo => ({
  ...t,
  columns: new Map([...t.columns, [c.name, c]]),
});

const withoutColumn = (t: TableInfo, name: string): TableInfo => {
  const columns = new Map(t.columns);

  columns.delete(name);

  return { ...t, columns };
};

describe('checkTableShape', () => {
  it('passes the twin table and the orders tables with no problems', () => {
    expect(checkTableShape(twinMapping(), tablesOf(twinTable()))).toEqual({
      problems: [],
      warnings: expect.any(Array),
      ddl: [],
      created: [],
    });

    const twin = checkTableShape(twinMapping(), tablesOf(twinTable()));

    // Manila wall clock into TIMESTAMP columns under the default +00:00 session: the one thing the
    // twin needs the operator to know.
    expect(twin.warnings).toEqual([
      expect.stringMatching(
        new RegExp(
          'created_at is TIMESTAMP: .*Asia\\/Manila .*\\(currently \\+08:00\\) ' +
            'and mysql\\.sessionTimeZone is \\+00:00'
        )
      ),
      expect.stringMatching(/updated_at is TIMESTAMP/),
    ]);

    expect(checkTableShape(ordersMapping(), ordersTables())).toEqual({
      problems: [],
      warnings: [],
      ddl: [],
      created: [],
    });
  });

  it('reports missing tables with their DDL, absent map entries included', () => {
    const r = checkTableShape(ordersMapping(), new Map([['orders', null]]));

    expect(r.problems).toEqual([
      "missing table orders: create it from the mapping's .sql or pass --create-tables",
      "missing table orders_items: create it from the mapping's .sql or pass --create-tables",
    ]);

    expect(r.ddl).toHaveLength(2);
    expect(r.created).toEqual(['orders', 'orders_items']);
    expect(r.ddl[0]).toMatch(/^CREATE TABLE IF NOT EXISTS `orders` /);
    expect(r.ddl[1]).toMatch(/^CREATE TABLE IF NOT EXISTS `orders_items` /);

    const onlyChild = checkTableShape(
      ordersMapping(),
      new Map([...ordersTables(), ['orders_items', null]])
    );

    expect(onlyChild.problems).toEqual([expect.stringMatching(/^missing table orders_items/)]);
    expect(onlyChild.ddl).toHaveLength(1);
  });

  it('a missing table whose string key is wider than the key ledger stores gets no DDL', () => {
    const wide: Mapping = {
      ...ordersMapping(),
      key: { column: 'mongo_id', cast: 'string', sqlType: 'VARBINARY(1000)' },
    };

    const r = checkTableShape(wide, new Map([['orders', null]]));

    // The width problem does not start with `missing table `, so load's --create-tables filter
    // keeps it and the load stops before any CREATE.
    expect(r.problems[0]).toMatch(
      new RegExp(
        '^mapping orders: key\\.sqlType VARBINARY\\(1000\\) holds 1000 characters, ' +
          'more than the 760 the key ledger stores'
      )
    );

    expect(r.problems.slice(1)).toEqual([
      expect.stringMatching(/^missing table orders/),
      expect.stringMatching(/^missing table orders_items/),
    ]);

    expect(r.ddl).toEqual([]);
    expect(r.created).toEqual([]);

    const off = checkTableShape(wide, new Map([['orders', null]]), { keyLedger: false });

    expect(off.problems).toEqual([
      expect.stringMatching(/^missing table orders/),
      expect.stringMatching(/^missing table orders_items/),
    ]);

    expect(off.ddl).toHaveLength(2);
    expect(off.ddl[0]).toContain('`mongo_id` VARBINARY(1000) NULL');
  });

  it('key column: missing, not unique, padding or case-folding collation, CHAR, too long', () => {
    const base = twinTable();

    expect(
      checkTableShape(twinMapping(), tablesOf(withoutColumn(base, 'source_mongo_id'))).problems
    ).toEqual([expect.stringMatching(/key column source_mongo_id is missing/)]);

    expect(checkTableShape(twinMapping(), tablesOf({ ...base, uniqueKeys: [] })).problems).toEqual([
      expect.stringMatching(/needs a single-column PRIMARY KEY or UNIQUE KEY/),
    ]);

    const stringKey: Mapping = {
      ...twinMapping(),
      key: { column: 'source_mongo_id', cast: 'string' },
    };

    expect(checkTableShape(stringKey, tablesOf(base)).problems).toEqual([
      expect.stringMatching(/string key needs a NO PAD binary collation .*has utf8mb4_0900_ai_ci/),
    ]);

    // utf8mb4_bin is PAD SPACE: 'a' and 'a ' would share a row, so it is refused like the
    // case-insensitive one.
    const padBin = withColumn(
      base,
      col('source_mongo_id', 'varchar', {
        collation: 'utf8mb4_bin',
        charLength: 24,
        octetLength: 96,
      })
    );

    expect(checkTableShape(stringKey, tablesOf(padBin)).problems).toEqual([
      expect.stringMatching(/NO PAD binary collation .*has utf8mb4_bin/),
    ]);

    // utf8mb4_0900_as_cs is NO PAD but compares UCA weights, not bytes: canonically equivalent
    // strings would share a row.
    for (const asCs of ['utf8mb4_0900_as_cs', 'utf8mb4_ja_0900_as_cs']) {
      const weighted = withColumn(
        base,
        col('source_mongo_id', 'varchar', { collation: asCs, charLength: 24, octetLength: 96 })
      );

      expect(checkTableShape(stringKey, tablesOf(weighted)).problems).toEqual([
        expect.stringMatching(new RegExp(`NO PAD binary collation .*has ${asCs}`)),
      ]);
    }

    const charKey = withColumn(
      base,
      col('source_mongo_id', 'char', {
        collation: 'utf8mb4_0900_bin',
        charLength: 24,
        octetLength: 96,
      })
    );

    expect(checkTableShape(stringKey, tablesOf(charKey)).problems).toEqual([
      expect.stringMatching(/needs VARCHAR or VARBINARY, not CHAR/),
    ]);

    const binKey = withColumn(
      base,
      col('source_mongo_id', 'varchar', {
        collation: 'utf8mb4_0900_bin',
        charLength: 24,
        octetLength: 96,
      })
    );

    expect(checkTableShape(stringKey, tablesOf(binKey)).problems).toEqual([]);

    // readTableInfo reports VARBINARY (information_schema gives it no collation) as `binary`.
    const binaryKey = withColumn(
      base,
      col('source_mongo_id', 'varbinary', { collation: 'binary', charLength: 24, octetLength: 24 })
    );

    expect(checkTableShape(stringKey, tablesOf(binaryKey)).problems).toEqual([]);

    const blobKey = withColumn(
      base,
      col('source_mongo_id', 'binary', { collation: 'binary', charLength: 24, octetLength: 24 })
    );

    expect(checkTableShape(stringKey, tablesOf(blobKey)).problems).toEqual([
      expect.stringMatching(/needs VARCHAR or VARBINARY, not BINARY/),
    ]);

    const longKey = withColumn(
      base,
      col('source_mongo_id', 'varchar', {
        collation: 'utf8mb4_0900_bin',
        charLength: 1000,
        octetLength: 4000,
      })
    );

    expect(checkTableShape(stringKey, tablesOf(longKey)).problems).toEqual([
      expect.stringMatching(/1000 characters exceed the 760 the key ledger stores/),
    ]);

    // Without the key ledger nothing stores the key, so the 760 rule does not apply.
    expect(checkTableShape(stringKey, tablesOf(longKey), { keyLedger: false }).problems).toEqual(
      []
    );
  });

  it('a child parentColumn of a string key needs the same NO PAD binary collation', () => {
    const tables = ordersTables();
    const stringKey: Mapping = { ...ordersMapping(), key: { column: 'mongo_id', cast: 'string' } };

    tables.set(
      'orders',
      withColumn(
        tables.get('orders') as TableInfo,
        col('mongo_id', 'varchar', {
          collation: 'utf8mb4_0900_bin',
          charLength: 64,
          octetLength: 256,
        })
      )
    );

    tables.set(
      'orders_items',
      withColumn(
        tables.get('orders_items') as TableInfo,
        col('order_mongo_id', 'varchar', {
          nullable: false,
          collation: 'utf8mb4_0900_ai_ci',
          charLength: 64,
          octetLength: 256,
        })
      )
    );

    expect(checkTableShape(stringKey, tables).problems).toEqual([
      expect.stringMatching(
        /orders_items\.order_mongo_id: a string key needs a NO PAD binary collation/
      ),
    ]);

    tables.set(
      'orders_items',
      withColumn(
        tables.get('orders_items') as TableInfo,
        col('order_mongo_id', 'varchar', {
          nullable: false,
          collation: 'utf8mb4_0900_bin',
          charLength: 64,
          octetLength: 256,
        })
      )
    );

    expect(checkTableShape(stringKey, tables).problems).toEqual([]);
  });

  it('a key as single-column PRIMARY KEY passes; other unique or primary keys are problems', () => {
    const base = twinTable();
    const keyPk = withoutColumn({ ...base, primaryKey: ['source_mongo_id'], uniqueKeys: [] }, 'id');

    expect(checkTableShape(twinMapping(), tablesOf(keyPk)).problems).toEqual([]);

    const extraUnique = {
      ...base,
      uniqueKeys: [
        ...base.uniqueKeys,
        { name: 'uq_actor', columns: ['actor_id', 'created_at'], prefix: false },
      ],
    };

    expect(checkTableShape(twinMapping(), tablesOf(extraUnique)).problems).toEqual([
      expect.stringMatching(/UNIQUE KEY uq_actor \(actor_id, created_at\) could match a row/),
    ]);

    const naturalPk = { ...base, primaryKey: ['actor_id'] };

    expect(checkTableShape(twinMapping(), tablesOf(naturalPk)).problems).toEqual([
      expect.stringMatching(
        /PRIMARY KEY \(actor_id\) is neither the key column nor an unwritten AUTO_INCREMENT id/
      ),
    ]);

    const compositePk = { ...base, primaryKey: ['id', 'actor_id'] };

    expect(checkTableShape(twinMapping(), tablesOf(compositePk)).problems).toEqual([
      expect.stringMatching(/PRIMARY KEY \(id, actor_id\)/),
    ]);
  });

  it('a prefix UNIQUE or PRIMARY KEY on the key column is refused: shared prefixes collide', () => {
    const base = twinTable();

    const prefixed = {
      ...base,
      uniqueKeys: [{ name: 'uq_ale_source_mongo_id', columns: ['source_mongo_id'], prefix: true }],
    };

    expect(checkTableShape(twinMapping(), tablesOf(prefixed)).problems).toEqual([
      expect.stringMatching(
        new RegExp(
          'the key needs a full-column UNIQUE key; ' +
            'uq_ale_source_mongo_id indexes only the first N characters'
        )
      ),
    ]);

    const keyPk = withoutColumn(
      { ...base, primaryKey: ['source_mongo_id'], primaryKeyPrefix: true, uniqueKeys: [] },
      'id'
    );

    expect(checkTableShape(twinMapping(), tablesOf(keyPk)).problems).toEqual([
      expect.stringMatching(/PRIMARY indexes only the first N characters/),
    ]);
  });

  it('a runIdColumn narrower than the run id or not a string column is a problem up front', () => {
    const base = twinTable();
    const options: ShapeOptions = { keyLedger: true, loadRunId: 'load-20261013T040000Z' };

    expect(checkTableShape(twinMapping(), tablesOf(base), options).problems).toEqual([]);

    const narrow = withColumn(
      base,
      col('backfill_run_id', 'varchar', {
        collation: 'utf8mb4_0900_ai_ci',
        charLength: 8,
        octetLength: 32,
      })
    );

    expect(checkTableShape(twinMapping(), tablesOf(narrow), options).problems).toEqual([
      expect.stringMatching(
        new RegExp(
          'backfill_run_id: varchar\\(8\\) is shorter than the run id ' +
            'load-20261013T040000Z \\(21 characters\\)'
        )
      ),
    ]);

    const numeric = withColumn(base, col('backfill_run_id', 'int'));

    expect(checkTableShape(twinMapping(), tablesOf(numeric), options).problems).toEqual([
      expect.stringMatching(/runIdColumn must be a CHAR, VARCHAR or TEXT column, not int/),
    ]);
  });

  it('an unindexed child parentColumn warns at concurrency 1 and is a problem above it', () => {
    const tables = ordersTables();
    const items = tables.get('orders_items') as TableInfo;

    tables.set('orders_items', { ...items, indexedColumns: ['id'] });

    expect(
      checkTableShape(ordersMapping(), tables, { keyLedger: true, concurrency: 1 }).warnings
    ).toEqual([
      expect.stringMatching(
        /orders_items\.order_mongo_id has no index; every batch's DELETE scans the table$/
      ),
    ]);

    expect(
      checkTableShape(ordersMapping(), tables, { keyLedger: true, concurrency: 4 }).problems
    ).toEqual([
      expect.stringMatching(
        new RegExp(
          'order_mongo_id has no index; .* concurrent chunks deadlock on it; ' +
            'add an index or set load.concurrency 1'
        )
      ),
    ]);
  });

  it('mapped, provenance and child columns must exist; fsp may not exceed the column', () => {
    const base = twinTable();

    expect(
      checkTableShape(twinMapping(), tablesOf(withoutColumn(base, 'ip_address'))).problems
    ).toEqual([expect.stringMatching(/mapped column ip_address is missing/)]);

    expect(
      checkTableShape(twinMapping(), tablesOf(withoutColumn(base, 'backfill_run_id'))).problems
    ).toEqual([expect.stringMatching(/runIdColumn backfill_run_id is missing/)]);

    const withChunk: Mapping = { ...twinMapping(), chunkColumn: 'chunk_id', extraColumn: 'extra' };

    expect(checkTableShape(withChunk, tablesOf(base)).problems).toEqual([
      expect.stringMatching(/chunkColumn chunk_id is missing/),
      expect.stringMatching(/extraColumn extra is missing/),
    ]);

    const fsp3: Mapping = {
      ...twinMapping(),
      columns: twinMapping().columns.map(c => (c.column === 'created_at' ? { ...c, fsp: 3 } : c)),
    };

    expect(checkTableShape(fsp3, tablesOf(base)).problems).toEqual([
      expect.stringMatching(/created_at: mapping fsp 3 exceeds the column's 0; MySQL would round/),
    ]);

    // DATE and string columns have no fractional precision to exceed: DATE takes the literal,
    // VARCHAR stores it, a short VARCHAR cannot.
    expect(
      checkTableShape(fsp3, tablesOf(withColumn(base, col('created_at', 'date')))).problems
    ).toEqual([]);

    expect(
      checkTableShape(
        fsp3,
        tablesOf(
          withColumn(
            base,
            col('created_at', 'varchar', {
              collation: 'utf8mb4_0900_ai_ci',
              charLength: 32,
              octetLength: 128,
            })
          )
        )
      ).problems
    ).toEqual([]);

    expect(
      checkTableShape(
        fsp3,
        tablesOf(
          withColumn(
            base,
            col('created_at', 'varchar', {
              collation: 'utf8mb4_0900_ai_ci',
              charLength: 19,
              octetLength: 76,
            })
          )
        )
      ).problems
    ).toEqual([
      expect.stringMatching(
        /a datetime literal with fsp 3 is 23 characters, varchar\(19\) is shorter/
      ),
    ]);

    const tables = ordersTables();
    const items = tables.get('orders_items') as TableInfo;

    tables.set(
      'orders_items',
      withoutColumn(withoutColumn(withoutColumn(items, 'order_mongo_id'), 'item_index'), 'qty')
    );

    expect(checkTableShape(ordersMapping(), tables).problems).toEqual([
      expect.stringMatching(/orders_items: parentColumn order_mongo_id is missing/),
      expect.stringMatching(/orders_items: indexColumn item_index is missing/),
      expect.stringMatching(/orders_items: mapped column qty is missing/),
    ]);
  });

  it('an unmapped NOT NULL without default is a problem unless AUTO_INCREMENT or generated', () => {
    const base = twinTable();

    const strict = withColumn(
      base,
      col('tenant', 'varchar', { nullable: false, charLength: 32, octetLength: 128 })
    );

    expect(checkTableShape(twinMapping(), tablesOf(strict)).problems).toEqual([
      expect.stringMatching(/tenant is NOT NULL without a default and no mapping entry writes it/),
    ]);

    const defaulted = withColumn(
      base,
      col('tenant', 'varchar', {
        nullable: false,
        hasDefault: true,
        charLength: 32,
        octetLength: 128,
      })
    );

    expect(checkTableShape(twinMapping(), tablesOf(defaulted)).problems).toEqual([]);

    const generated = withColumn(
      base,
      col('tenant_len', 'int', { nullable: false, hasDefault: true })
    );

    expect(checkTableShape(twinMapping(), tablesOf(generated)).problems).toEqual([]);

    const tables = ordersTables();

    tables.set(
      'orders_items',
      withColumn(
        tables.get('orders_items') as TableInfo,
        col('warehouse', 'varchar', { nullable: false, charLength: 8, octetLength: 32 })
      )
    );

    expect(checkTableShape(ordersMapping(), tables).problems).toEqual([
      expect.stringMatching(/orders_items.warehouse is NOT NULL without a default/),
    ]);
  });

  it('warns about NOT NULL mapped columns without a default and an unindexed chunk column', () => {
    const noDefault: Mapping = {
      ...twinMapping(),
      columns: twinMapping().columns.map(c =>
        c.column === 'actor_id' ? { column: 'actor_id', source: 'actor_id', cast: 'string' } : c
      ),
    };

    const r = checkTableShape(noDefault, tablesOf(twinTable()));

    expect(r.problems).toEqual([]);

    expect(r.warnings).toContainEqual(
      expect.stringMatching(/actor_id is NOT NULL and the mapping has no default/)
    );

    const tables = ordersTables();
    const orders = tables.get('orders') as TableInfo;

    tables.set('orders', { ...orders, indexedColumns: ['id', 'mongo_id'] });

    expect(checkTableShape(ordersMapping(), tables).warnings).toEqual([
      expect.stringMatching(/_msm_chunk has no index/),
    ]);

    tables.set('orders', { ...orders, indexedColumns: ['id', 'mongo_id', '_msm_chunk'] });
    expect(checkTableShape(ordersMapping(), tables).warnings).toEqual([]);
  });

  it('TIMESTAMP columns warn when cast zone and mysql.sessionTimeZone disagree, either way', () => {
    const manila = checkTableShape(twinMapping(), tablesOf(twinTable()), {
      keyLedger: true,
      sessionTimeZone: '+08:00',
    });

    expect(manila.warnings).toEqual([]);

    // The silent bad pair: infer's default UTC cast under the application's +08:00 session shifts
    // every row by 8 hours.
    const utc: Mapping = {
      ...twinMapping(),
      columns: twinMapping().columns.map(c =>
        c.cast === 'datetime' ? { ...c, timezone: 'UTC' } : c
      ),
    };

    const shifted = checkTableShape(utc, tablesOf(twinTable()), {
      keyLedger: true,
      sessionTimeZone: '+08:00',
    });

    expect(shifted.warnings).toEqual([
      expect.stringMatching(
        new RegExp(
          'created_at is TIMESTAMP: the cast writes UTC wall-clock values ' +
            '\\(currently \\+00:00\\) and mysql\\.sessionTimeZone is \\+08:00'
        )
      ),
      expect.stringMatching(/updated_at is TIMESTAMP/),
    ]);

    expect(
      checkTableShape(utc, tablesOf(twinTable()), { keyLedger: true, sessionTimeZone: '+00:00' })
        .warnings
    ).toEqual([]);

    expect(checkTableShape(utc, tablesOf(twinTable())).warnings).toEqual([]);

    // A half-hour zone compares on its full offset.
    const kolkata: Mapping = {
      ...twinMapping(),
      columns: twinMapping().columns.map(c =>
        c.cast === 'datetime' ? { ...c, timezone: 'Asia/Kolkata' } : c
      ),
    };

    expect(
      checkTableShape(kolkata, tablesOf(twinTable()), {
        keyLedger: true,
        sessionTimeZone: '+05:30',
      }).warnings
    ).toEqual([]);

    expect(
      checkTableShape(kolkata, tablesOf(twinTable()), {
        keyLedger: true,
        sessionTimeZone: '+05:00',
      }).warnings
    ).toHaveLength(2);
  });

  it('flags cast/column pairs that never fit: ObjectId on numeric/short, json on numeric', () => {
    const base = twinTable();

    expect(
      checkTableShape(
        twinMapping(),
        tablesOf(withColumn(base, col('source_mongo_id', 'bigint unsigned')))
      ).problems
    ).toEqual([
      expect.stringMatching(
        /source_mongo_id: an ObjectId \(24 hex characters\) cannot go into bigint unsigned/
      ),
    ]);

    expect(
      checkTableShape(
        twinMapping(),
        tablesOf(
          withColumn(
            base,
            col('source_mongo_id', 'char', {
              collation: 'utf8mb4_0900_ai_ci',
              charLength: 12,
              octetLength: 48,
            })
          )
        )
      ).problems
    ).toEqual([expect.stringMatching(/an ObjectId is 24 characters, char\(12\) is shorter/)]);

    expect(
      checkTableShape(
        twinMapping(),
        tablesOf(
          withColumn(
            base,
            col('source_mongo_id', 'binary', {
              collation: 'binary',
              charLength: 12,
              octetLength: 12,
            })
          )
        )
      ).problems
    ).toEqual([expect.stringMatching(/an ObjectId is 24 hex characters, binary\(12\) is shorter/)]);

    expect(
      checkTableShape(
        twinMapping(),
        tablesOf(
          withColumn(
            base,
            col('source_mongo_id', 'varbinary', {
              collation: 'binary',
              charLength: 24,
              octetLength: 24,
            })
          )
        )
      ).problems
    ).toEqual([]);

    const oidColumn: Mapping = {
      ...twinMapping(),
      columns: [...twinMapping().columns, { column: 'ref', source: 'ref', cast: 'objectId' }],
    };

    expect(
      checkTableShape(oidColumn, tablesOf(withColumn(base, col('ref', 'int')))).problems
    ).toEqual([expect.stringMatching(/ref: an ObjectId \(24 hex characters\) cannot go into int/)]);

    expect(
      checkTableShape(
        oidColumn,
        tablesOf(
          withColumn(
            base,
            col('ref', 'varchar', {
              collation: 'utf8mb4_0900_ai_ci',
              charLength: 32,
              octetLength: 128,
            })
          )
        )
      ).problems
    ).toEqual([]);

    expect(
      checkTableShape(
        twinMapping(),
        tablesOf(withColumn(base, col('data', 'decimal', { precision: 10, scale: 2 })))
      ).problems
    ).toEqual([expect.stringMatching(/data: a json cast cannot go into decimal/)]);

    expect(
      checkTableShape(
        twinMapping(),
        tablesOf(
          withColumn(
            base,
            col('data', 'text', { collation: 'utf8mb4_0900_ai_ci', octetLength: 65535 })
          )
        )
      ).problems
    ).toEqual([]);
  });

  it('provenance columns: NOT NULL or non-JSON extraColumn, chunkColumn too small for ids', () => {
    const base = twinTable();
    const withExtra: Mapping = { ...twinMapping(), chunkColumn: 'chunk_id', extraColumn: 'extra' };

    const good = tablesOf(
      withColumn(withColumn(base, col('chunk_id', 'bigint unsigned')), col('extra', 'json'))
    );

    expect(checkTableShape(withExtra, good).problems).toEqual([]);

    const notNull = tablesOf(
      withColumn(
        withColumn(base, col('chunk_id', 'bigint unsigned')),
        col('extra', 'json', { nullable: false, hasDefault: true })
      )
    );

    expect(checkTableShape(withExtra, notNull).problems).toEqual([
      expect.stringMatching(
        /extra: extraColumn is NOT NULL, but a fully mapped document leaves it NULL/
      ),
    ]);

    const numericExtra = tablesOf(
      withColumn(withColumn(base, col('chunk_id', 'bigint unsigned')), col('extra', 'int'))
    );

    expect(checkTableShape(withExtra, numericExtra).problems).toEqual([
      expect.stringMatching(/extra: extraColumn must be a JSON or text column, not int/),
    ]);

    const textExtra = tablesOf(
      withColumn(
        withColumn(
          base,
          col('chunk_id', 'varchar', {
            collation: 'utf8mb4_0900_ai_ci',
            charLength: 32,
            octetLength: 128,
          })
        ),
        col('extra', 'text', { collation: 'utf8mb4_0900_ai_ci', octetLength: 65535 })
      )
    );

    expect(checkTableShape(withExtra, textExtra).problems).toEqual([]);

    const narrowChunk = tablesOf(
      withColumn(withColumn(base, col('chunk_id', 'int unsigned')), col('extra', 'json'))
    );

    expect(checkTableShape(withExtra, narrowChunk).problems).toEqual([
      expect.stringMatching(
        /chunk_id: chunkColumn must be BIGINT, BIGINT UNSIGNED or a text column, not int unsigned/
      ),
    ]);
  });

  it('lists every problem together', () => {
    const base = withoutColumn(
      withoutColumn({ ...twinTable(), uniqueKeys: [] }, 'data'),
      'backfill_run_id'
    );

    const r = checkTableShape(twinMapping(), tablesOf(base));

    expect(r.problems).toHaveLength(3);
  });
});
