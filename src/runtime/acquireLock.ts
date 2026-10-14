import { randomBytes } from 'node:crypto';
import { link, mkdir, readFile, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import msmError from './msmError.js';

/** `identity` is `<boot_id>:<process start ticks>` on Linux, where pids are reused across container restarts. */
interface LockBody { pid: number; hostname: string; started_at: string; identity: string | null }

/** Lock files this process holds: a lock naming our own pid that is not here was left by another process with that pid. */
const held = new Set<string>();

/**
 * The holder touches its lock this often. A lock nobody touched for `staleAfterMs` has no live holder behind
 * it; one whose pid looks dead from here is taken over after `deadAfterMs` (three missed heartbeats), since a
 * holder in another PID namespace on the same hostname (a host-network container beside a host cron, or two
 * containers in one pod) is invisible to `kill(pid, 0)` and shows another identity in /proc, yet still touches its lock.
 */
const heartbeatMs = 30_000;
const staleAfterMs = 5 * 60_000;
const deadAfterMs = 3 * heartbeatMs;

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
};

/** The process start time (field 22 of /proc/<pid>/stat, after the parenthesised command) plus the boot id. */
async function processIdentity(pid: number): Promise<string | null> {
  if (process.platform !== 'linux') return null;
  try {
    const [stat, boot] = await Promise.all([readFile(`/proc/${pid}/stat`, 'utf8'), readFile('/proc/sys/kernel/random/boot_id', 'utf8')]);
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const startTicks = fields[19];
    return startTicks === undefined ? null : `${boot.trim()}:${startTicks}`;
  } catch {
    return null;
  }
}

/** How long ago the lock file was last written or touched; a missing file counts as infinitely old. */
async function ageMs(path: string, now: number): Promise<number> {
  try {
    return now - (await stat(path)).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * The lock file appears with its body in one step: the body is written to a private temp file and hard-linked
 * to the lock name, which fails with EEXIST when another process got there first. A reader can therefore never
 * see an empty lock and mistake it for garbage.
 */
async function createLock(dir: string, path: string, body: string): Promise<boolean> {
  const temp = join(dir, `.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  await writeFile(temp, body);
  try {
    await link(temp, path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    return false;
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

/**
 * A stale lock is taken over by renaming it to a private name first: only the process whose rename wins
 * removes it, and only when the renamed body is the one it judged stale. Two processes that find the same
 * stale lock can then never delete each other's fresh lock. A live lock renamed by mistake is put back with
 * `link`, which never overwrites a lock a third process created meanwhile.
 */
async function takeOver(dir: string, path: string, judged: string): Promise<void> {
  const mine = join(dir, `.${process.pid}.${randomBytes(6).toString('hex')}.stale`);
  try {
    await rename(path, mine);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; // someone else already took it over
    throw err;
  }
  const body = await readFile(mine, 'utf8').catch(() => null);
  // A different body means the lock was replaced between the read and the rename: it is live, put it back.
  if (body !== judged) await link(mine, path).catch(() => undefined);
  await unlink(mine).catch(() => undefined);
}

/**
 * One running instance per command per state directory. A lock left by a dead process on this host is
 * taken over (reported through `warn`); one from another host needs `--force-unlock`, since its liveness
 * cannot be checked from here. A live pid whose recorded process identity is not the identity of the process
 * that holds that pid now (a container restart reused the pid) is dead too. Every takeover that is not forced
 * also needs the heartbeat to be stale: the holder touches the lock every 30 seconds, so a pid that looks gone
 * or replaced is taken over only once nobody has touched the lock for 90 seconds (a holder in another PID
 * namespace on this hostname looks exactly like that from here), and a lock naming our own pid that this
 * process does not hold (a restart, or a sibling container that is also pid 1) only once untouched for five
 * minutes. Before that a lock is refused like any live lock. The result releases the lock.
 */
export default async function acquireLock(stateDir: string, command: string, force: boolean, warn?: (message: string) => void): Promise<() => Promise<void>> {
  const dir = join(stateDir, 'locks');
  const path = join(dir, `${command}.lock`);
  await mkdir(dir, { recursive: true });
  const body: LockBody = { pid: process.pid, hostname: hostname(), started_at: new Date().toISOString(), identity: await processIdentity(process.pid) };
  const text = JSON.stringify(body);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await createLock(dir, path, text)) {
      held.add(path);
      const heartbeat = setInterval(() => {
        const now = new Date();
        utimes(path, now, now).catch(() => undefined);
      }, heartbeatMs);
      heartbeat.unref();
      return async () => {
        clearInterval(heartbeat);
        held.delete(path);
        await unlink(path).catch(() => undefined);
      };
    }
    const raw = await readFile(path, 'utf8').catch(() => null);
    if (raw === null) continue; // released between the link and the read: try again
    let existing: Partial<LockBody> = {};
    try {
      existing = JSON.parse(raw) as Partial<LockBody>;
    } catch {
      existing = {};
    }
    const sameHost = existing.hostname === body.hostname;
    let dead = false;
    let why = `pid ${existing.pid ?? '?'} is gone`;
    if (sameHost && typeof existing.pid === 'number') {
      const age = await ageMs(path, Date.now());
      const untouched = `has not touched it for ${Math.round(age / 1000)} s`;
      if (existing.pid === process.pid) {
        // Our own pid, not held here: the identity check cannot tell a restart from a sibling PID namespace, so the heartbeat decides.
        if (!held.has(path)) {
          dead = age > staleAfterMs;
          why = `pid ${existing.pid} has not touched it for ${Math.round(age / 60_000)} minutes`;
        }
      } else {
        let looksDead = false;
        if (!pidAlive(existing.pid)) looksDead = true;
        else if (typeof existing.identity === 'string') {
          const now = await processIdentity(existing.pid);
          looksDead = now !== null && now !== existing.identity;
          why = `pid ${existing.pid} is another process now`;
        }
        // A pid that is gone or replaced from here may still be a live holder in another PID namespace: the heartbeat decides.
        dead = looksDead && age > deadAfterMs;
        if (looksDead) why = `${why} and ${untouched}`;
      }
    }
    if (!force && !dead && (typeof existing.pid === 'number' || typeof existing.hostname === 'string')) {
      throw msmError('lock', `${command} already running (pid ${existing.pid ?? '?'} on ${existing.hostname ?? '?'}); pass --force-unlock if it is gone`, { fatal: true });
    }
    warn?.(force ? `replacing the ${command} lock (--force-unlock)` : `replacing a stale ${command} lock (${why})`);
    await takeOver(dir, path, raw);
  }
  throw msmError('lock', `${command}: could not take the lock`, { fatal: true });
}
