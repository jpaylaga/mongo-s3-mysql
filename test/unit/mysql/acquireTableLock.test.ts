import { describe, expect, it, vi } from 'vitest';
import acquireTableLock from '#mysql/acquireTableLock';
import { fakeMysql, header } from './fakeMysql.js';

describe('acquireTableLock', () => {
  it('takes GET_LOCK on a dedicated connection, raises wait_timeout, releases both', async () => {
    const t = fakeMysql([
      [/^SELECT GET_LOCK\(\?, 0\) AS got$/, [{ got: 1 }]],
      [/^SET SESSION wait_timeout/, header(0)],
      [/^SELECT RELEASE_LOCK/, [{ r: 1 }]],
    ]);

    const lock = await acquireTableLock(t.mysql, 'archive', 'audit_log_entries', () => undefined);

    expect(lock.name).toMatch(/^msm:[0-9a-f]{40}$/);

    expect(t.sqls('lock')).toEqual([
      'SELECT GET_LOCK(?, 0) AS got',
      'SET SESSION wait_timeout = 31536000',
    ]);

    await lock.release();
    expect(t.sqls('lock').at(-1)).toBe('SELECT RELEASE_LOCK(?)');

    // Every statement on the holder carries the 30 s bound: none of them may wait on a half-open
    // socket or a global read lock.
    expect(t.calls.filter(c => c.conn === 'lock').map(c => c.timeout)).toEqual([
      30_000, 30_000, 30_000,
    ]);

    expect(t.counts).toMatchObject({ connected: 1, ended: 1, lockDestroyed: 0 });
  });

  it('a failure after GET_LOCK or a timed-out release destroys the connection', async () => {
    const stalled = Object.assign(new Error('Query inactivity timeout'), {
      code: 'PROTOCOL_SEQUENCE_TIMEOUT',
      fatal: true,
    });

    const t = fakeMysql([
      [/^SELECT GET_LOCK/, [{ got: 1 }]],
      [
        /^SET SESSION/,
        () => {
          throw stalled;
        },
      ],
    ]);

    await expect(acquireTableLock(t.mysql, 'archive', 'orders', () => undefined)).rejects.toBe(
      stalled
    );

    expect(t.counts).toMatchObject({ lockDestroyed: 1, ended: 0 });

    const r = fakeMysql([
      [/^SELECT GET_LOCK/, [{ got: 1 }]],
      [/^SET SESSION/, header(0)],
      [
        /^SELECT RELEASE_LOCK/,
        () => {
          throw stalled;
        },
      ],
    ]);

    const lock = await acquireTableLock(r.mysql, 'archive', 'orders', () => undefined);

    await lock.release();
    expect(r.counts).toMatchObject({ lockDestroyed: 1, ended: 0 });
  });

  it('destroy() marks the lock lost: torn down once, and release sends nothing', async () => {
    const t = fakeMysql([
      [/^SELECT GET_LOCK/, [{ got: 1 }]],
      [/^SET SESSION/, header(0)],
    ]);

    const lock = await acquireTableLock(t.mysql, 'archive', 'orders', () => undefined);

    lock.destroy();
    lock.destroy();
    await lock.release();
    expect(t.counts).toMatchObject({ lockDestroyed: 1, ended: 0 });

    expect(t.sqls('lock')).toEqual([
      'SELECT GET_LOCK(?, 0) AS got',
      'SET SESSION wait_timeout = 31536000',
    ]);
  });

  it('a lock another loader holds is fatal and closes the connection', async () => {
    const t = fakeMysql([[/^SELECT GET_LOCK/, [{ got: 0 }]]]);

    await expect(
      acquireTableLock(t.mysql, 'archive', 'orders', () => undefined)
    ).rejects.toMatchObject({
      msmCode: 'lock',
      fatal: true,
      message: 'another loader holds the lock on archive.orders; wait for it to finish',
    });

    expect(t.counts.ended).toBe(1);
  });

  it('pings the holder every minute with a timeout; a failed ping is a lost lock', async () => {
    vi.useFakeTimers();

    try {
      let fail = false;

      const t = fakeMysql([
        [/^SELECT GET_LOCK/, [{ got: 1 }]],
        [/^SET SESSION/, header(0)],
        [
          /^SELECT 1$/,
          () => {
            if (fail) throw new Error('socket gone');

            return [{ 1: 1 }];
          },
        ],
        [/^SELECT RELEASE_LOCK/, []],
      ]);

      const lost: Error[] = [];
      const lock = await acquireTableLock(t.mysql, 'archive', 'orders', err => lost.push(err));

      await vi.advanceTimersByTimeAsync(60_000);

      const pings = () => t.calls.filter(c => c.conn === 'lock' && c.sql === 'SELECT 1');

      expect(pings()).toHaveLength(1);
      // The ping carries the 30 s query timeout, so a half-open socket fails it instead of hanging
      // it.
      expect(pings()[0]?.timeout).toBe(30_000);
      expect(lost).toEqual([]);
      fail = true;
      await vi.advanceTimersByTimeAsync(60_000);

      expect(lost[0]).toMatchObject({
        msmCode: 'lock',
        fatal: true,
        message: 'lock on orders lost: socket gone',
      });

      // A failed ping destroys the connection at once (the timed-out command would block anything
      // sent after it) and stops the pings.
      expect(t.counts.lockDestroyed).toBe(1);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(pings()).toHaveLength(2);
      // Releasing a lost lock sends nothing: RELEASE_LOCK and end() would queue behind the dead
      // ping; the server freed the lock with the session.
      await lock.release();
      expect(t.sqls('lock').some(s => s.startsWith('SELECT RELEASE_LOCK'))).toBe(false);
      expect(t.counts).toMatchObject({ ended: 0, lockDestroyed: 1 });
    } finally {
      vi.useRealTimers();
    }
  });
});
