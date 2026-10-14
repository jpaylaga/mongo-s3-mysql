import { readFile } from 'node:fs/promises';
import { createConnection, createPool } from 'mysql2/promise';
import type { Connection, ConnectionOptions, Pool, PoolConnection } from 'mysql2/promise';
import toSafeNumber from '#mysql/toSafeNumber';
import msmError from '#runtime/msmError';
import type { MysqlConfig, MysqlHandle } from '#types';

/** Strict mode so a value MySQL would silently truncate or zero fails the batch instead. */
const sqlMode =
  'STRICT_ALL_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,' +
  'ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';

/**
 * TCP keepalive after 30 s of silence, instead of the OS default (2 hours on Linux): a half-open
 * connection in the middle of a batch or under the lock ping must surface as an error, not hang the
 * chunk for hours.
 */
const keepAliveInitialDelay = 30_000;

function sessionStatements(sessionTimeZone: string): string[] {
  return [
    'SET NAMES utf8mb4',
    `SET SESSION sql_mode = '${sqlMode}', time_zone = '${sessionTimeZone}', ` +
      `transaction_isolation = 'READ-COMMITTED'`,
  ];
}

/** Rejects MariaDB and MySQL before 8.0.19, which lack the `VALUES ... AS alias` upsert form. */
function checkVersion(version: string): void {
  if (/mariadb/i.test(version))
    throw msmError(
      'config',
      `MySQL 8.0.19 or newer is required; the server is MariaDB (${version})`,
      { fatal: true }
    );

  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);

  if (!m)
    throw msmError(
      'config',
      `MySQL 8.0.19 or newer is required; cannot read the server version "${version}"`,
      { fatal: true }
    );

  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const tooOld = major < 8 || (major === 8 && minor === 0 && patch < 19);

  if (tooOld)
    throw msmError('config', `MySQL 8.0.19 or newer is required; the server is ${version}`, {
      fatal: true,
    });
}

/**
 * A pool for the load and reconcile commands plus `connect()` for the dedicated GET_LOCK holders.
 * Every connection, pooled or not, gets the same session: utf8mb4, strict mode, the configured
 * time_zone and READ-COMMITTED. FOUND_ROWS is off so `affectedRows` counts inserted plus 2 x
 * changed rows. The version check and the first session statements run on one dedicated connection
 * before the pool exists, so a server that refuses them (MariaDB, an old MySQL, a time zone it
 * rejects) fails with its own message instead of a stream error from a destroyed pool connection.
 */
export default async function createMysql(
  config: MysqlConfig,
  password: string,
  connectionLimit: number
): Promise<MysqlHandle> {
  const ca = config.caFile === undefined ? undefined : await readFile(config.caFile, 'utf8');

  const options: ConnectionOptions = {
    host: config.host,
    port: config.port,
    user: config.user,
    password,
    database: config.database,
    connectTimeout: config.connectTimeoutMs,
    keepAliveInitialDelay,
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true,
    multipleStatements: false,
    flags: ['-FOUND_ROWS'],
    ssl:
      config.tls === 'off'
        ? undefined
        : { rejectUnauthorized: true, ...(ca === undefined ? {} : { ca }) },
  };

  const session = sessionStatements(config.sessionTimeZone);

  const connect = async (): Promise<Connection> => {
    const conn = await createConnection(options);

    try {
      for (const sql of session) await conn.query(sql);
    } catch (err) {
      conn.destroy();

      throw err;
    }

    return conn;
  };

  let version: string;
  let maxAllowedPacket: number;
  const probe = await createConnection(options);

  try {
    const [versionRows] = await probe.query('SELECT VERSION() AS version');

    version = String((versionRows as { version: unknown }[])[0]?.version ?? '');
    checkVersion(version);

    for (const sql of session) await probe.query(sql);

    const [packetRows] = await probe.query('SELECT @@max_allowed_packet AS max_allowed_packet');

    maxAllowedPacket = toSafeNumber(
      (packetRows as { max_allowed_packet: unknown }[])[0]?.max_allowed_packet ?? 0,
      'max_allowed_packet'
    );
  } finally {
    probe.destroy();
  }

  const pool: Pool = createPool({ ...options, connectionLimit, waitForConnections: true });

  // The core pool emits `connection` right after the handshake and before the first handout, so
  // statements queued here run ahead of any query on that connection. The statements passed on the
  // probe above, so a failure here is transient: the connection is destroyed and the pool opens
  // another one for the next query.
  pool.on('connection', (conn: PoolConnection) => {
    for (const sql of session) {
      (conn as unknown as { query(sql: string, cb: (err: unknown) => void): void }).query(
        sql,
        err => {
          if (err) conn.destroy();
        }
      );
    }
  });

  return { pool, maxAllowedPacket, version, connect, close: () => pool.end() };
}
