import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import inventoryCommand from '#cli/commands/inventoryCommand';
import { exampleConfigJson, tmpDir } from '../../../helpers.js';

const quiet = { writeErr: () => {}, writeOut: () => {} };

const program = (config: string) =>
  new Command()
    .name('mongo-s3-mysql')
    .exitOverride()
    .configureOutput(quiet)
    .option('-c, --config <path>', 'config file', config)
    .option('-C, --collections <names>')
    .option('-y, --yes')
    .option('--json')
    .addCommand(inventoryCommand().exitOverride().configureOutput(quiet));

async function configFile(text: string): Promise<string> {
  const path = join(await tmpDir(), 'mongo-s3-mysql.config.json');

  await writeFile(path, text);

  return path;
}

describe('inventoryCommand', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('declares the documented flags', () => {
    const help = inventoryCommand().helpInformation();

    for (const flag of ['--all', '--sample <n>', '--write-config', '--force'])
      expect(help).toContain(flag);
  });

  it('rejects an unknown option and a sample that is not a positive integer', async () => {
    const path = await configFile(JSON.stringify(exampleConfigJson));

    await expect(program(path).parseAsync(['node', 'cli', 'inventory', '--deep'])).rejects.toThrow(
      /unknown option/
    );

    await expect(
      program(path).parseAsync(['node', 'cli', 'inventory', '--sample', '0'])
    ).rejects.toThrow(/positive integer/);
  });

  it('--write-config refuses a non-empty list without --force, before connecting', async () => {
    const path = await configFile(JSON.stringify(exampleConfigJson));

    vi.stubEnv('MSM_MONGO_URI', '');

    await expect(
      program(path).parseAsync(['node', 'cli', 'inventory', '--write-config'])
    ).rejects.toThrow(`${path} lists 3 collections; pass --force to replace them`);

    // With --force the file passes and the run then needs the connection string, which is the next
    // thing checked.
    await expect(
      program(path).parseAsync(['node', 'cli', 'inventory', '--write-config', '--force'])
    ).rejects.toThrow('config: set MSM_MONGO_URI to the MongoDB connection string');
  });

  it('--write-config reads the config before connecting; faults never echo the text', async () => {
    // No MSM_MONGO_URI: a run that got past the config read would fail on the env var, not on the
    // file.
    vi.stubEnv('MSM_MONGO_URI', '');

    const run = (path: string, ...args: string[]) =>
      program(path).parseAsync(['node', 'cli', 'inventory', '--write-config', ...args]);

    const path = await configFile(
      '{"mongo": {"database": "app"}, "s3": {"bucket": "b-b-b"}, "mysql": ' +
        '{"password": hunter2-supersecret}}'
    );

    await expect(run(path, '--force')).rejects.toThrow(
      /mongo-s3-mysql\.config\.json:1:\d+: invalid JSON$/
    );

    await expect(run(path, '--force')).rejects.not.toThrow(/hunter2/);

    const secret = await configFile(
      JSON.stringify({
        ...exampleConfigJson,
        mysql: { ...exampleConfigJson.mysql, password: 'hunter2-supersecret' },
      })
    );

    await expect(run(secret, '--force')).rejects.toThrow(
      /mysql\.password must not be in the config/
    );

    await expect(run(secret, '--force')).rejects.not.toThrow(/hunter2/);

    const listed = await configFile(JSON.stringify(exampleConfigJson));

    await expect(run(listed)).rejects.toThrow(/lists 3 collections; pass --force to replace them/);

    const ok = await configFile(JSON.stringify({ ...exampleConfigJson, collections: [] }));

    await expect(run(ok)).rejects.toThrow(/set MSM_MONGO_URI/);
  });
});
