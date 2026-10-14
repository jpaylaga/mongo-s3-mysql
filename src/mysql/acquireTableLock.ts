import { createHash } from 'node:crypto';
import errorMessage from '#runtime/errorMessage';
import msmError from '#runtime/msmError';
import type { MysqlHandle, TableLock } from '#types';

/**
 * A chunk holds the lock connection idle for its whole length; the server must not time it out
 * meanwhile.
 */
const lockSessionTimeoutSeconds = 31_536_000;
const lockPingMs = 60_000;
/**
 * A ping that takes longer than this is a half-open socket: the lock is as good as lost; every
 * other statement on this connection gets the same bound.
 */
const pingTimeoutMs = 30_000;
const timed = (sql: string) => ({ sql, timeout: pingTimeoutMs });

/**
 * `GET_LOCK` names are limited to 64 characters; a hash keeps any database and table name inside
 * that.
 */
const lockName = (database: string, table: string): string =>
  `msm:${createHash('sha1').update(`${database}.${table}`).digest('hex').slice(0, 40)}`;

/**
 * One `GET_LOCK` per target table on a dedicated connection, so two loaders never write the same
 * table at once. The holder sits idle for a chunk's length: its `wait_timeout` is raised to a year
 * and a `SELECT 1` every minute keeps the socket alive; a ping that fails or stalls destroys the
 * connection (a timed-out mysql2 query stays the connection's current command, so anything sent
 * after it would wait for the OS to give the socket up) and calls `onLost` with a fatal lock error.
 * GET_LOCK, the session statement and RELEASE_LOCK carry the same timeout, and a failure after the
 * connect destroys the connection, so a lock already taken is never leaked on a stalled socket. The
 * server releases the lock with the session. A lock another loader holds is refused at once.
 */
export default async function acquireTableLock(
  mysql: MysqlHandle,
  database: string,
  table: string,
  onLost: (err: Error) => void
): Promise<TableLock> {
  const conn = await mysql.connect();
  const name = lockName(database, table);

  try {
    const [rows] = await conn.query(timed('SELECT GET_LOCK(?, 0) AS got'), [name]);

    if (Number((rows as { got?: unknown }[])[0]?.got) !== 1) {
      await conn.end().catch(() => undefined);

      throw msmError(
        'lock',
        `another loader holds the lock on ${database}.${table}; wait for it to finish`,
        { fatal: true }
      );
    }

    await conn.query(timed(`SET SESSION wait_timeout = ${lockSessionTimeoutSeconds}`));
  } catch (err) {
    if (!(err as { msmCode?: unknown }).msmCode) conn.destroy();

    throw err;
  }

  let lost = false;

  const destroy = (): void => {
    if (lost) return;

    lost = true;
    clearInterval(ping);
    conn.destroy();
  };

  const ping = setInterval(() => {
    conn.query(timed('SELECT 1')).catch((err: unknown) => {
      destroy();

      onLost(
        msmError('lock', `lock on ${table} lost: ${errorMessage(err)}`, { fatal: true, cause: err })
      );
    });
  }, lockPingMs);

  ping.unref();

  return {
    conn,
    name,
    destroy,
    async release() {
      if (lost) return;

      clearInterval(ping);

      // A release that times out leaves the command pending on the socket, so the connection is
      // torn down instead of ended.
      const released = await conn.query(timed('SELECT RELEASE_LOCK(?)'), [name]).then(
        () => true,
        () => false
      );

      if (released) await conn.end().catch(() => undefined);
      else conn.destroy();
    },
  };
}
