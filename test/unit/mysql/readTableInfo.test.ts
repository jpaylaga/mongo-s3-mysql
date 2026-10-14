import type { Pool } from 'mysql2/promise';
import { describe, expect, it } from 'vitest';
import readTableInfo from '#mysql/readTableInfo';

const columnRow = (over: Record<string, unknown>) => ({
  COLUMN_NAME: 'x',
  DATA_TYPE: 'varchar',
  COLUMN_TYPE: 'varchar(255)',
  IS_NULLABLE: 'YES',
  COLUMN_DEFAULT: null,
  EXTRA: '',
  COLLATION_NAME: 'utf8mb4_0900_ai_ci',
  CHARACTER_MAXIMUM_LENGTH: '255',
  CHARACTER_OCTET_LENGTH: '1020',
  NUMERIC_PRECISION: null,
  NUMERIC_SCALE: null,
  DATETIME_PRECISION: null,
  ...over,
});

/**
 * A pool whose `query` answers the two information_schema statements from scripted rows and records
 * the parameters.
 */
function fakePool(columns: unknown[], indexes: unknown[]) {
  const calls: { sql: string; params: unknown[] }[] = [];

  const pool = {
    async query(sql: string, params: unknown[]) {
      calls.push({ sql, params });

      return [sql.includes('information_schema.COLUMNS') ? columns : indexes, []];
    },
  } as unknown as Pool;

  return { pool, calls };
}

describe('readTableInfo', () => {
  it('returns null for a table with no columns', async () => {
    const { pool, calls } = fakePool([], []);

    expect(await readTableInfo(pool, 'archive', 'missing')).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params).toEqual(['archive', 'missing']);
  });

  it('maps information_schema rows to ColumnInfo, keys and indexed columns', async () => {
    const { pool } = fakePool(
      [
        columnRow({
          COLUMN_NAME: 'id',
          DATA_TYPE: 'bigint',
          COLUMN_TYPE: 'bigint unsigned',
          IS_NULLABLE: 'NO',
          EXTRA: 'auto_increment',
          COLLATION_NAME: null,
          CHARACTER_MAXIMUM_LENGTH: null,
          CHARACTER_OCTET_LENGTH: null,
          NUMERIC_PRECISION: '20',
          NUMERIC_SCALE: '0',
        }),
        columnRow({ COLUMN_NAME: 'actor_id', IS_NULLABLE: 'NO' }),
        columnRow({
          COLUMN_NAME: 'total',
          DATA_TYPE: 'decimal',
          COLUMN_TYPE: 'decimal(14,2)',
          COLLATION_NAME: null,
          CHARACTER_MAXIMUM_LENGTH: null,
          CHARACTER_OCTET_LENGTH: null,
          NUMERIC_PRECISION: '14',
          NUMERIC_SCALE: '2',
        }),
        columnRow({
          COLUMN_NAME: 'created_at',
          DATA_TYPE: 'timestamp',
          COLUMN_TYPE: 'timestamp',
          COLUMN_DEFAULT: 'CURRENT_TIMESTAMP',
          IS_NULLABLE: 'NO',
          EXTRA: 'DEFAULT_GENERATED',
          COLLATION_NAME: null,
          CHARACTER_MAXIMUM_LENGTH: null,
          CHARACTER_OCTET_LENGTH: null,
          DATETIME_PRECISION: '0',
        }),
        columnRow({
          COLUMN_NAME: 'computed',
          DATA_TYPE: 'int',
          COLUMN_TYPE: 'int',
          IS_NULLABLE: 'NO',
          EXTRA: 'STORED GENERATED',
          COLLATION_NAME: null,
          CHARACTER_MAXIMUM_LENGTH: null,
          CHARACTER_OCTET_LENGTH: null,
          NUMERIC_PRECISION: '10',
          NUMERIC_SCALE: '0',
        }),
        columnRow({
          COLUMN_NAME: 'source_mongo_id',
          DATA_TYPE: 'char',
          COLUMN_TYPE: 'char(24)',
          CHARACTER_MAXIMUM_LENGTH: '24',
          CHARACTER_OCTET_LENGTH: '96',
        }),
      ],
      [
        { INDEX_NAME: 'PRIMARY', NON_UNIQUE: '0', SEQ_IN_INDEX: '1', COLUMN_NAME: 'id' },
        {
          INDEX_NAME: 'idx_actor_id_created_at',
          NON_UNIQUE: '1',
          SEQ_IN_INDEX: '1',
          COLUMN_NAME: 'actor_id',
        },
        {
          INDEX_NAME: 'idx_actor_id_created_at',
          NON_UNIQUE: '1',
          SEQ_IN_INDEX: '2',
          COLUMN_NAME: 'created_at',
        },
        {
          INDEX_NAME: 'uq_ale_source_mongo_id',
          NON_UNIQUE: '0',
          SEQ_IN_INDEX: '1',
          COLUMN_NAME: 'source_mongo_id',
        },
        { INDEX_NAME: 'uq_pair', NON_UNIQUE: 0, SEQ_IN_INDEX: 1, COLUMN_NAME: 'actor_id' },
        { INDEX_NAME: 'uq_pair', NON_UNIQUE: 0, SEQ_IN_INDEX: 2, COLUMN_NAME: 'total' },
      ]
    );

    const info = await readTableInfo(pool, 'archive', 'audit_log_entries');

    expect(info).not.toBeNull();
    expect(info?.name).toBe('audit_log_entries');

    expect([...(info?.columns.keys() ?? [])]).toEqual([
      'id',
      'actor_id',
      'total',
      'created_at',
      'computed',
      'source_mongo_id',
    ]);

    expect(info?.columns.get('id')).toEqual({
      name: 'id',
      dataType: 'bigint unsigned',
      nullable: false,
      hasDefault: false,
      autoIncrement: true,
      collation: null,
      charLength: null,
      octetLength: null,
      precision: 20,
      scale: 0,
      fsp: null,
      members: null,
    });

    expect(info?.columns.get('actor_id')).toMatchObject({
      dataType: 'varchar',
      nullable: false,
      hasDefault: false,
      charLength: 255,
      octetLength: 1020,
      collation: 'utf8mb4_0900_ai_ci',
    });

    expect(info?.columns.get('total')).toMatchObject({
      dataType: 'decimal',
      precision: 14,
      scale: 2,
    });

    expect(info?.columns.get('created_at')).toMatchObject({
      dataType: 'timestamp',
      hasDefault: true,
      fsp: 0,
    });

    expect(info?.columns.get('computed')).toMatchObject({ hasDefault: true, autoIncrement: false });
    expect(info?.primaryKey).toEqual(['id']);

    expect(info?.uniqueKeys).toEqual([
      { name: 'uq_ale_source_mongo_id', columns: ['source_mongo_id'], prefix: false },
      { name: 'uq_pair', columns: ['actor_id', 'total'], prefix: false },
    ]);

    expect(info?.primaryKeyPrefix).toBe(false);
    expect(info?.indexedColumns).toEqual(['id', 'actor_id', 'source_mongo_id']);
  });

  it('reads VARBINARY and BLOB as collation binary, ENUM/SET members, prefix indexes', async () => {
    const { pool } = fakePool(
      [
        columnRow({
          COLUMN_NAME: 'k',
          DATA_TYPE: 'varbinary',
          COLUMN_TYPE: 'varbinary(8)',
          COLLATION_NAME: null,
          CHARACTER_MAXIMUM_LENGTH: '8',
          CHARACTER_OCTET_LENGTH: '8',
        }),
        columnRow({
          COLUMN_NAME: 'blob_col',
          DATA_TYPE: 'tinyblob',
          COLUMN_TYPE: 'tinyblob',
          COLLATION_NAME: null,
          CHARACTER_MAXIMUM_LENGTH: '255',
          CHARACTER_OCTET_LENGTH: '255',
        }),
        columnRow({
          COLUMN_NAME: 'status',
          DATA_TYPE: 'enum',
          COLUMN_TYPE: "enum('open','paid','it''s')",
          CHARACTER_MAXIMUM_LENGTH: '4',
          CHARACTER_OCTET_LENGTH: '16',
        }),
        columnRow({
          COLUMN_NAME: 'flags',
          DATA_TYPE: 'set',
          COLUMN_TYPE: "set('a','b')",
          CHARACTER_MAXIMUM_LENGTH: '3',
          CHARACTER_OCTET_LENGTH: '12',
        }),
        columnRow({
          COLUMN_NAME: 'note',
          DATA_TYPE: 'text',
          COLUMN_TYPE: 'text',
          CHARACTER_MAXIMUM_LENGTH: '65535',
          CHARACTER_OCTET_LENGTH: '65535',
        }),
      ],
      [
        {
          INDEX_NAME: 'PRIMARY',
          NON_UNIQUE: '0',
          SEQ_IN_INDEX: '1',
          COLUMN_NAME: 'k',
          SUB_PART: null,
        },
        {
          INDEX_NAME: 'uq_note',
          NON_UNIQUE: '0',
          SEQ_IN_INDEX: '1',
          COLUMN_NAME: 'note',
          SUB_PART: '10',
        },
      ]
    );

    const info = await readTableInfo(pool, 'archive', 't');

    expect(info?.columns.get('k')).toMatchObject({
      dataType: 'varbinary',
      collation: 'binary',
      members: null,
    });

    expect(info?.columns.get('blob_col')).toMatchObject({ collation: 'binary' });

    expect(info?.columns.get('status')).toMatchObject({
      collation: 'utf8mb4_0900_ai_ci',
      members: ['open', 'paid', "it's"],
    });

    expect(info?.columns.get('flags')?.members).toEqual(['a', 'b']);
    expect(info?.columns.get('note')?.members).toBeNull();
    expect(info?.primaryKeyPrefix).toBe(false);
    expect(info?.uniqueKeys).toEqual([{ name: 'uq_note', columns: ['note'], prefix: true }]);
  });
});
