import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { exampleConfig, tmpDir } from '../../helpers.js';
import type { MysqlConfig } from '../../../src/types.js';

/** A scripted mysql2/promise: records every option and statement, answers version and packet queries. */
const state = vi.hoisted(() => ({
  version: '8.0.36', packet: '67108864', poolOptions: null as Record<string, unknown> | null, connOptions: null as Record<string, unknown> | null,
  poolQueries: [] as string[], connQueries: [] as string[], ended: 0, connDestroyed: 0, failConnSql: null as string | null,
}));

vi.mock('mysql2/promise', async () => {
  const { EventEmitter } = await import('node:events');
  const answer = (sql: string): unknown[] => {
    if (sql.includes('VERSION()')) return [[{ version: state.version }], []];
    if (sql.includes('max_allowed_packet')) return [[{ max_allowed_packet: state.packet }], []];
    return [[], []];
  };
  class FakePool extends EventEmitter {
    async query(sql: string) { state.poolQueries.push(sql); return answer(sql); }
    async end() { state.ended += 1; }
  }
  return {
    createPool: (options: Record<string, unknown>) => { state.poolOptions = options; return new FakePool(); },
    createConnection: async (options: Record<string, unknown>) => {
      state.connOptions = options;
      return {
        async query(sql: string) { state.connQueries.push(sql); if (sql === state.failConnSql) throw new Error('SET failed'); return answer(sql); },
        destroy() { state.connDestroyed += 1; },
      };
    },
  };
});

const { default: createMysql } = await import('../../../src/mysql/createMysql.js');

const mysqlConfig = (overrides: Record<string, unknown> = {}): MysqlConfig => {
  const mysql = { host: 'mysql.example.internal', user: 'archive_loader', database: 'archive', ...overrides };
  return exampleConfig({ mysql }).mysql as MysqlConfig;
};

beforeEach(() => {
  Object.assign(state, { version: '8.0.36', packet: '67108864', poolOptions: null, connOptions: null, poolQueries: [], connQueries: [], ended: 0, connDestroyed: 0, failConnSql: null });
});

describe('createMysql', () => {
  it('builds the pool with the loader connection options and reads version and max_allowed_packet', async () => {
    const handle = await createMysql(mysqlConfig({ tls: 'off' }), 'hunter2', 6);
    expect(state.poolOptions).toMatchObject({
      host: 'mysql.example.internal', port: 3306, user: 'archive_loader', password: 'hunter2', database: 'archive', connectionLimit: 6,
      supportBigNumbers: true, bigNumberStrings: true, dateStrings: true, multipleStatements: false, flags: ['-FOUND_ROWS'], connectTimeout: 10_000,
      keepAliveInitialDelay: 30_000,
    });
    expect(state.poolOptions?.ssl).toBeUndefined();
    expect(handle.version).toBe('8.0.36');
    expect(handle.maxAllowedPacket).toBe(67108864);
    // The version check and the session statements run on one dedicated probe connection before the pool exists, then it is destroyed.
    expect(state.poolQueries).toEqual([]);
    expect(state.connQueries).toEqual([
      'SELECT VERSION() AS version',
      'SET NAMES utf8mb4',
      "SET SESSION sql_mode = 'STRICT_ALL_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION', time_zone = '+00:00', transaction_isolation = 'READ-COMMITTED'",
      'SELECT @@max_allowed_packet AS max_allowed_packet',
    ]);
    expect(state.connDestroyed).toBe(1);
    await handle.close();
    expect(state.ended).toBe(1);
  });

  it('a session statement the server refuses fails with the server\'s own error before any pool exists', async () => {
    state.failConnSql = 'SET NAMES utf8mb4';
    await expect(createMysql(mysqlConfig(), 'pw', 2)).rejects.toThrow('SET failed');
    expect(state.poolOptions).toBeNull();
    expect(state.connDestroyed).toBe(1);
  });

  it('enables TLS by default and reads the CA file', async () => {
    const dir = await tmpDir();
    const caFile = join(dir, 'ca.pem');
    await writeFile(caFile, 'PEM');
    await createMysql(mysqlConfig({ caFile }), 'pw', 2);
    expect(state.poolOptions?.ssl).toEqual({ rejectUnauthorized: true, ca: 'PEM' });
    await createMysql(mysqlConfig(), 'pw', 2);
    expect(state.poolOptions?.ssl).toEqual({ rejectUnauthorized: true });
  });

  it('runs the session statements on every pooled connection before it is handed out', async () => {
    const handle = await createMysql(mysqlConfig({ sessionTimeZone: '+08:00' }), 'pw', 2);
    const queued: string[] = [];
    let destroyed = 0;
    const coreConnection = { query: (sql: string, cb: (err: unknown) => void) => { queued.push(sql); cb(null); }, destroy: () => { destroyed += 1; } };
    handle.pool.emit('connection', coreConnection);
    expect(queued).toEqual([
      'SET NAMES utf8mb4',
      "SET SESSION sql_mode = 'STRICT_ALL_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION', time_zone = '+08:00', transaction_isolation = 'READ-COMMITTED'",
    ]);
    expect(destroyed).toBe(0);
    handle.pool.emit('connection', { query: (_sql: string, cb: (err: unknown) => void) => cb(new Error('no')), destroy: () => { destroyed += 1; } });
    expect(destroyed).toBe(2);
  });

  it('connect() opens a dedicated connection with the same options and session', async () => {
    const handle = await createMysql(mysqlConfig({ tls: 'off' }), 'pw', 2);
    state.connQueries = [];
    const conn = await handle.connect();
    expect(conn).toBeDefined();
    expect(state.connOptions).toMatchObject({ host: 'mysql.example.internal', password: 'pw', flags: ['-FOUND_ROWS'] });
    expect(state.connOptions).not.toHaveProperty('connectionLimit');
    expect(state.connQueries).toEqual([
      'SET NAMES utf8mb4',
      "SET SESSION sql_mode = 'STRICT_ALL_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION', time_zone = '+00:00', transaction_isolation = 'READ-COMMITTED'",
    ]);
    state.failConnSql = 'SET NAMES utf8mb4';
    await expect(handle.connect()).rejects.toThrow('SET failed');
    expect(state.connDestroyed).toBe(2);
  });

  it('refuses MariaDB and MySQL before 8.0.19 as fatal config errors before the session statements, so the friendly message always prints', async () => {
    for (const [version, pattern] of [['10.11.6-MariaDB', /MariaDB/], ['8.0.18', /server is 8\.0\.18/], ['5.7.44-log', /server is 5\.7\.44/], ['weird', /cannot read/]] as const) {
      state.version = version;
      state.connQueries = [];
      state.connDestroyed = 0;
      await expect(createMysql(mysqlConfig(), 'pw', 2)).rejects.toMatchObject({ msmCode: 'config', fatal: true, message: expect.stringMatching(pattern) });
      expect(state.connQueries).toEqual(['SELECT VERSION() AS version']);
      expect(state.connDestroyed).toBe(1);
    }
    for (const version of ['8.0.19', '8.4.3', '9.1.0']) {
      state.version = version;
      await expect(createMysql(mysqlConfig(), 'pw', 2)).resolves.toMatchObject({ version });
    }
  });

  it('refuses a max_allowed_packet beyond 2^53', async () => {
    state.packet = '9007199254740992';
    await expect(createMysql(mysqlConfig(), 'pw', 2)).rejects.toThrow(/max_allowed_packet .* is outside/);
  });
});
