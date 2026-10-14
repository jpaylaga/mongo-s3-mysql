import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import resolveContext from '../../../src/cli/resolveContext.js';
import { exampleConfigJson, tmpDir } from '../../helpers.js';

/** A parsed program whose subcommand `name` carries the global options, as cli.ts builds it. */
function parsed(name: string, argv: string[]): Promise<Command> {
  return new Promise((resolve) => {
    const program = new Command().name('mongo-s3-mysql')
      .option('-c, --config <path>', 'config file', 'mongo-s3-mysql.config.json')
      .option('-C, --collections <names>').option('--json').option('--log-format <format>', '', 'text').option('-y, --yes').option('--force-unlock')
      .addCommand(new Command(name).action((_opts, cmd: Command) => resolve(cmd)));
    program.parse(['node', 'cli', ...argv]);
  });
}

async function configFile(overrides: Record<string, unknown> = {}) {
  const dir = await tmpDir();
  const path = join(dir, 'cfg.json');
  await writeFile(path, JSON.stringify({ ...structuredClone(exampleConfigJson), ...overrides }));
  return path;
}

describe('resolveContext', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('loads the config, selects -C collections and creates only the needed clients', async () => {
    const path = await configFile();
    vi.stubEnv('MSM_MONGO_URI', 'mongodb://u:hunter2@h/app');
    const cmd = await parsed('verify', ['-c', path, '-C', 'orders', '--json', '--yes', 'verify']);
    const before = process.listenerCount('SIGINT');
    const cli = await resolveContext(cmd, { s3: true });
    expect(cli.ctx.command).toBe('verify');
    expect(cli.collections.map((c) => c.name)).toEqual(['orders']);
    expect(cli.globals).toMatchObject({ config: path, collections: 'orders', json: true, yes: true, logFormat: 'text' });
    expect(cli.store?.bucket).toBe('example-archive-bucket');
    expect(cli.mongo).toBeUndefined();
    expect(cli.mysql).toBeUndefined();
    expect(cli.ctx.secrets).toContain('mongodb://u:hunter2@h/app');
    expect(process.listenerCount('SIGINT')).toBe(before + 1);
    await cli.close();
    expect(process.listenerCount('SIGINT')).toBe(before);
  });

  it('fails early when a needed env secret or the mysql section is missing', async () => {
    const path = await configFile();
    vi.stubEnv('MSM_MONGO_URI', '');
    await expect(resolveContext(await parsed('export', ['-c', path, 'export']), { mongo: true, s3: true })).rejects.toThrow('config: set MSM_MONGO_URI to the MongoDB connection string');
    const noMysql = await configFile({ mysql: undefined });
    await expect(resolveContext(await parsed('load', ['-c', noMysql, 'load']), { s3: true, mysql: true })).rejects.toThrow('config: the "mysql" section is required');
    vi.stubEnv('MSM_MYSQL_PASSWORD', undefined as never);
    await expect(resolveContext(await parsed('load', ['-c', path, 'load']), { s3: true, mysql: true })).rejects.toThrow('config: set MSM_MYSQL_PASSWORD to the MySQL password');
  });

  it('rejects an unknown command name and a missing config file', async () => {
    const path = await configFile();
    await expect(resolveContext(await parsed('init', ['-c', path, 'init']), {})).rejects.toThrow('unknown command init');
    await expect(resolveContext(await parsed('verify', ['-c', '/nope/cfg.json', 'verify']), {})).rejects.toThrow(/ENOENT/);
  });
});
