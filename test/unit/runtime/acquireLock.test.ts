import { mkdir, readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import acquireLock from '../../../src/runtime/acquireLock.js';
import { tmpDir } from '../../helpers.js';

describe('acquireLock', () => {
  it('takes, holds and releases a lock file with pid and host', async () => {
    const dir = await tmpDir();
    const release = await acquireLock(dir, 'export', false);
    const body = JSON.parse(await readFile(join(dir, 'locks', 'export.lock'), 'utf8'));
    expect(body).toMatchObject({ pid: process.pid, hostname: hostname() });
    await expect(acquireLock(dir, 'export', false)).rejects.toThrow(/export already running \(pid \d+ on .+\); pass --force-unlock/);
    await expect(acquireLock(dir, 'load', false)).resolves.toBeTypeOf('function');
    await release();
    await expect(acquireLock(dir, 'export', false)).resolves.toBeTypeOf('function');
  });

  it('replaces a same-host lock whose pid is gone once its heartbeat is stale, with a warning; a fresh one is refused', async () => {
    const dir = await tmpDir();
    await acquireLock(dir, 'verify', false);
    const path = join(dir, 'locks', 'verify.lock');
    await writeFile(path, JSON.stringify({ pid: 2 ** 22 - 7, hostname: hostname(), started_at: 'x' }));
    // Touched seconds ago: a holder in another PID namespace on this hostname looks exactly like a dead pid from here.
    await expect(acquireLock(dir, 'verify', false)).rejects.toMatchObject({ msmCode: 'lock', message: expect.stringContaining(`pid ${2 ** 22 - 7}`) });
    const twoMinutesAgo = new Date(Date.now() - 120_000);
    await utimes(path, twoMinutesAgo, twoMinutesAgo);
    const warnings: string[] = [];
    await acquireLock(dir, 'verify', false, (m) => warnings.push(m));
    expect(warnings[0]).toMatch(/^replacing a stale verify lock \(pid \d+ is gone and has not touched it for 1\d\d s\)$/);
  });

  it('a lock naming our own pid that this process does not hold is refused while fresh (a sibling container that is also pid 1) and taken over once untouched for minutes (a restart)', async () => {
    const dir = await tmpDir();
    await mkdir(join(dir, 'locks'), { recursive: true });
    const path = join(dir, 'locks', 'export.lock');
    await writeFile(path, JSON.stringify({ pid: process.pid, hostname: hostname(), started_at: 'x', identity: null }));
    // Fresh: the heartbeat cannot tell it apart from a live sibling, so it is a live lock.
    await expect(acquireLock(dir, 'export', false)).rejects.toMatchObject({ msmCode: 'lock', message: expect.stringContaining(`pid ${process.pid}`) });
    const sixMinutesAgo = new Date(Date.now() - 6 * 60_000);
    await utimes(path, sixMinutesAgo, sixMinutesAgo);
    const warnings: string[] = [];
    const release = await acquireLock(dir, 'export', false, (m) => warnings.push(m));
    expect(warnings[0]).toBe(`replacing a stale export lock (pid ${process.pid} has not touched it for 6 minutes)`);
    // While this process holds it, the same lock is refused.
    await expect(acquireLock(dir, 'export', false)).rejects.toMatchObject({ msmCode: 'lock' });
    await release();
  });

  it('the holder touches its lock every 30 seconds, so a live lock never looks stale', async () => {
    // Only the interval is faked: the touch itself goes through the thread pool and is awaited on the real clock.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const dir = await tmpDir();
      const release = await acquireLock(dir, 'export', false);
      const path = join(dir, 'locks', 'export.lock');
      const old = new Date(Date.now() - 10 * 60_000);
      await utimes(path, old, old);
      expect((await stat(path)).mtimeMs).toBeLessThan(Date.now() - 9 * 60_000);
      await vi.advanceTimersByTimeAsync(30_000);
      for (let i = 0; i < 50 && (await stat(path)).mtimeMs < Date.now() - 60_000; i += 1) await new Promise((resolve) => { setTimeout(resolve, 10); });
      expect((await stat(path)).mtimeMs).toBeGreaterThan(Date.now() - 60_000);
      await release();
    } finally {
      vi.useRealTimers();
    }
  });

  it('on Linux the lock records a process identity and a live pid with another identity is taken over', async () => {
    const dir = await tmpDir();
    const release = await acquireLock(dir, 'export', false);
    const body = JSON.parse(await readFile(join(dir, 'locks', 'export.lock'), 'utf8')) as { identity: string | null };
    expect(body.identity === null || /^[0-9a-f-]+:\d+$/.test(body.identity)).toBe(true);
    if (process.platform === 'linux') expect(body.identity).not.toBeNull();
    await release();
    await writeFile(join(dir, 'locks', 'export.lock'), JSON.stringify({ pid: process.ppid, hostname: hostname(), started_at: 'x', identity: 'boot:1' }));
    const old = new Date(Date.now() - 120_000);
    await utimes(join(dir, 'locks', 'export.lock'), old, old);
    const warnings: string[] = [];
    if (process.platform === 'linux') {
      await (await acquireLock(dir, 'export', false, (m) => warnings.push(m)))();
      expect(warnings[0]).toMatch(/stale export lock/);
    } else {
      await expect(acquireLock(dir, 'export', false)).rejects.toMatchObject({ msmCode: 'lock' });
    }
  });

  it('refuses a foreign-host lock unless forced', async () => {
    const dir = await tmpDir();
    await acquireLock(dir, 'load', false);
    await writeFile(join(dir, 'locks', 'load.lock'), JSON.stringify({ pid: 1234, hostname: 'host-a', started_at: 'x' }));
    await expect(acquireLock(dir, 'load', false)).rejects.toMatchObject({ msmCode: 'lock', fatal: true, message: expect.stringContaining('pid 1234 on host-a') });
    const warnings: string[] = [];
    await acquireLock(dir, 'load', true, (m) => warnings.push(m));
    expect(warnings[0]).toMatch(/--force-unlock/);
  });

it('creates the lock with its body in one step and leaves no temp files behind', async () => {
    const dir = await tmpDir();
    const release = await acquireLock(dir, 'export', false);
    expect((await readdir(join(dir, 'locks'))).sort()).toEqual(['export.lock']);
    await release();
    expect(await readdir(join(dir, 'locks'))).toEqual([]);
  });

  it('two processes finding the same stale lock cannot delete each other\'s fresh lock', async () => {
    const dir = await tmpDir();
    await mkdir(join(dir, 'locks'), { recursive: true });
    const stale = JSON.stringify({ pid: 2 ** 22 - 7, hostname: hostname(), started_at: 'x', identity: null });
    await writeFile(join(dir, 'locks', 'load.lock'), stale);
    const old = new Date(Date.now() - 120_000);
    await utimes(join(dir, 'locks', 'load.lock'), old, old);
    const outcomes = await Promise.allSettled([acquireLock(dir, 'load', false), acquireLock(dir, 'load', false)]);
    const won = outcomes.filter((o) => o.status === 'fulfilled');
    const lost = outcomes.filter((o) => o.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toMatchObject({ msmCode: 'lock' });
    // The winner's lock is intact and names this process.
    expect(JSON.parse(await readFile(join(dir, 'locks', 'load.lock'), 'utf8'))).toMatchObject({ pid: process.pid });
    await (won[0] as PromiseFulfilledResult<() => Promise<void>>).value();
  });

  it('an empty lock file (a crash between create and write by an older version) is taken over, not treated as live', async () => {
    const dir = await tmpDir();
    await mkdir(join(dir, 'locks'), { recursive: true });
    await writeFile(join(dir, 'locks', 'verify.lock'), '');
    const warnings: string[] = [];
    const release = await acquireLock(dir, 'verify', false, (m) => warnings.push(m));
    expect(warnings[0]).toMatch(/stale verify lock/);
    await release();
  });
});
