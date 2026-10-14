import mappingSchema from '#mapping/mappingSchema';
import type { ColumnInfo, Mapping, TableInfo } from '#types';

/** A ColumnInfo the way readTableInfo would build it, with every limit defaulted to "none". */
export function col(
  name: string,
  dataType: string,
  overrides: Partial<ColumnInfo> = {}
): ColumnInfo {
  return {
    name,
    dataType,
    nullable: true,
    hasDefault: false,
    autoIncrement: false,
    collation: null,
    charLength: null,
    octetLength: null,
    precision: null,
    scale: null,
    fsp: null,
    members: null,
    ...overrides,
  };
}

export function table(
  name: string,
  columns: ColumnInfo[],
  keys: {
    primaryKey?: string[];
    primaryKeyPrefix?: boolean;
    uniqueKeys?: { name: string; columns: string[]; prefix?: boolean }[];
    indexedColumns?: string[];
  } = {}
): TableInfo {
  // Fakes that name no indexes still count the primary key and unique keys as indexed, as
  // information_schema would.
  const indexedColumns = keys.indexedColumns ?? [
    ...new Set(
      [keys.primaryKey?.[0], ...(keys.uniqueKeys ?? []).map(k => k.columns[0])].filter(
        (c): c is string => c !== undefined
      )
    ),
  ];

  return {
    name,
    columns: new Map(columns.map(c => [c.name, c])),
    uniqueKeys: (keys.uniqueKeys ?? []).map(k => ({ ...k, prefix: k.prefix ?? false })),
    primaryKey: keys.primaryKey ?? [],
    primaryKeyPrefix: keys.primaryKeyPrefix ?? false,
    indexedColumns,
  };
}

const utf8 = 'utf8mb4_0900_ai_ci';

/**
 * The twin of the real migration target (docs/use-case.md), as information_schema would describe
 * it.
 */
export function twinTable(): TableInfo {
  return table(
    'audit_log_entries',
    [
      col('id', 'bigint unsigned', {
        nullable: false,
        autoIncrement: true,
        precision: 20,
        scale: 0,
      }),
      col('actor_id', 'varchar', {
        nullable: false,
        collation: utf8,
        charLength: 255,
        octetLength: 1020,
      }),
      col('description', 'text', {
        nullable: false,
        collation: utf8,
        charLength: 65535,
        octetLength: 65535,
      }),
      col('data', 'json', { hasDefault: false }),
      col('ip_address', 'varchar', { collation: utf8, charLength: 45, octetLength: 180 }),
      col('location', 'json'),
      col('created_at', 'timestamp', { fsp: 0 }),
      col('updated_at', 'timestamp', { fsp: 0 }),
      col('source_mongo_id', 'char', { collation: utf8, charLength: 24, octetLength: 96 }),
      col('backfill_run_id', 'varchar', { collation: utf8, charLength: 64, octetLength: 256 }),
    ],
    {
      primaryKey: ['id'],
      uniqueKeys: [{ name: 'uq_ale_source_mongo_id', columns: ['source_mongo_id'] }],
      indexedColumns: ['id', 'source_mongo_id', 'actor_id', 'created_at'],
    }
  );
}

/** The twin mapping of docs/use-case.md. */
export function twinMapping(): Mapping {
  return mappingSchema.parse({
    collection: 'audit_log',
    table: 'audit_log_entries',
    key: { column: 'source_mongo_id', cast: 'objectId' },
    runIdColumn: 'backfill_run_id',
    onCastError: 'reject',
    columns: [
      { column: 'actor_id', source: 'actor_id', cast: 'string', default: '' },
      { column: 'description', source: 'description', cast: 'string', default: '' },
      { column: 'data', source: 'data', cast: 'json' },
      { column: 'ip_address', source: 'ip_address', cast: 'string' },
      { column: 'location', source: 'location', cast: 'json' },
      {
        column: 'created_at',
        source: 'created_at',
        cast: 'datetime',
        fsp: 0,
        timezone: 'Asia/Manila',
      },
      {
        column: 'updated_at',
        source: 'updated_at',
        cast: 'datetime',
        fsp: 0,
        timezone: 'Asia/Manila',
      },
    ],
  });
}

/**
 * The orders mapping (the examples/orders.mapping.json golden), which mappingToDdl turns into the
 * documented DDL.
 */
export function ordersMapping(): Mapping {
  return mappingSchema.parse({
    collection: 'orders',
    table: 'orders',
    key: { column: 'mongo_id', cast: 'objectId', sqlType: 'CHAR(24)' },
    runIdColumn: 'import_run',
    chunkColumn: '_msm_chunk',
    extraColumn: '_extra',
    onCastError: 'reject',
    columns: [
      { column: 'status', source: 'status', cast: 'string', sqlType: 'VARCHAR(32)' },
      {
        column: 'total',
        source: 'total',
        cast: 'decimal',
        sqlType: 'DECIMAL(14,2)',
        note: 'decimal 58, int 2',
      },
      { column: 'sequence', source: 'sequence', cast: 'bigint', sqlType: 'BIGINT' },
      { column: 'paid', source: 'paid', cast: 'bool', sqlType: 'TINYINT(1)' },
      {
        column: 'created_at',
        source: 'createdAt',
        cast: 'datetime',
        fsp: 3,
        timezone: 'UTC',
        sqlType: 'DATETIME(3)',
      },
      { column: 'customer', source: 'customer', cast: 'json', sqlType: 'JSON' },
      { column: 'tags', source: 'tags', cast: 'json', sqlType: 'JSON' },
    ],
    children: [
      {
        table: 'orders_items',
        source: 'items',
        parentColumn: 'order_mongo_id',
        indexColumn: 'item_index',
        columns: [
          { column: 'sku', source: 'sku', cast: 'string', sqlType: 'VARCHAR(32)' },
          { column: 'qty', source: 'qty', cast: 'int', sqlType: 'INT' },
          { column: 'price', source: 'price', cast: 'decimal', sqlType: 'DECIMAL(10,2)' },
        ],
      },
    ],
  });
}

/** The orders tables as the golden DDL creates them. */
export function ordersTables(): Map<string, TableInfo> {
  const ascii = 'ascii_bin';

  const orders = table(
    'orders',
    [
      col('id', 'bigint unsigned', { nullable: false, autoIncrement: true }),
      col('status', 'varchar', { collation: utf8, charLength: 32, octetLength: 128 }),
      col('total', 'decimal', { precision: 14, scale: 2 }),
      col('sequence', 'bigint', { precision: 19, scale: 0 }),
      col('paid', 'tinyint', { precision: 3, scale: 0 }),
      col('created_at', 'datetime', { fsp: 3 }),
      col('customer', 'json'),
      col('tags', 'json'),
      col('mongo_id', 'char', { collation: ascii, charLength: 24, octetLength: 24 }),
      col('import_run', 'varchar', { collation: utf8, charLength: 64, octetLength: 256 }),
      col('_msm_chunk', 'bigint unsigned'),
      col('_extra', 'json'),
    ],
    {
      primaryKey: ['id'],
      uniqueKeys: [{ name: 'uq_orders_mongo_id', columns: ['mongo_id'] }],
      indexedColumns: ['id', 'mongo_id', '_msm_chunk'],
    }
  );

  const items = table(
    'orders_items',
    [
      col('id', 'bigint unsigned', { nullable: false, autoIncrement: true }),
      col('order_mongo_id', 'char', {
        nullable: false,
        collation: ascii,
        charLength: 24,
        octetLength: 24,
      }),
      col('item_index', 'int unsigned', { nullable: false }),
      col('sku', 'varchar', { collation: utf8, charLength: 32, octetLength: 128 }),
      col('qty', 'int', { precision: 10, scale: 0 }),
      col('price', 'decimal', { precision: 10, scale: 2 }),
    ],
    {
      primaryKey: ['id'],
      uniqueKeys: [{ name: 'uq_orders_items_parent', columns: ['order_mongo_id', 'item_index'] }],
      indexedColumns: ['id', 'order_mongo_id'],
    }
  );

  return new Map([
    ['orders', orders],
    ['orders_items', items],
  ]);
}
