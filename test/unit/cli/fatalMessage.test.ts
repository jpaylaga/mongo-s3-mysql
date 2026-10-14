import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import fatalMessage from '../../../src/cli/fatalMessage.js';
import resolveContext from '../../../src/cli/resolveContext.js';
import runSecrets from '../../../src/cli/runSecrets.js';
import { exampleConfigJson, tmpDir } from '../../helpers.js';

// The clients connect eagerly; here only the secrets they are given matter.
vi.mock('../../../src/mongo/createMongo.js', () => ({ default: vi.fn(async () => ({ client: {}, db: {}, close: async () => undefined })) }));
vi.mock('../../../src/mysql/createMysql.js', () => ({ default: vi.fn(async () => ({ pool: {}, maxAllowedPacket: 1, version: '8.0.36', connect: async () => ({}), close: async () => undefined })) }));

function parsed(name: string, argv: string[]): Promise<Command> {
  return new Promise((resolve) => {
    const program = new Command().name('mongo-s3-mysql')
      .option('-c, --config <path>', 'config file', 'mongo-s3-mysql.config.json')
      .option('-C, --collections <names>').option('--json').option('--log-format <format>', '', 'text').option('-y, --yes').option('--force-unlock')
      .addCommand(new Command(name).action((_opts, cmd: Command) => resolve(cmd)));
    program.parse(['node', 'cli', ...argv]);
  });
}

describe('fatalMessage', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    runSecrets.clear();
  });

  it('redacts with the conventional env scan even before any context exists', () => {
    vi.stubEnv('MSM_TEST_PASSWORD', 'hunter2');
    expect(fatalMessage(new Error('auth failed for hunter2'))).toBe('mongo-s3-mysql: auth failed for ***');
    expect(fatalMessage('plain string with hunter2')).toBe('mongo-s3-mysql: plain string with ***');
  });

  it('masks a custom-named URI and password that resolveContext read, which the name scan alone misses', async () => {
    const dir = await tmpDir();
    const path = join(dir, 'cfg.json');
    const base = structuredClone(exampleConfigJson) as { mongo: Record<string, unknown>; mysql: Record<string, unknown> };
    await writeFile(path, JSON.stringify({ ...base, mongo: { ...base.mongo, uriEnv: 'MONGO_CONN' }, mysql: { ...base.mysql, passwordEnv: 'MYSQL_PASS' } }));
    const uri = 'mongodb://h/app?x=abc123';
    vi.stubEnv('MONGO_CONN', uri);
    vi.stubEnv('MYSQL_PASS', 'hunter2');
    const err = new Error(`load failed: ${uri} with hunter2`);
    // Neither name matches /SECRET|TOKEN|PASSWORD|URI/ and the URI carries no userinfo, so nothing masks them yet.
    expect(fatalMessage(err)).toBe(`mongo-s3-mysql: load failed: ${uri} with hunter2`);
    const cli = await resolveContext(await parsed('load', ['-c', path, 'load']), { mongo: true, mysql: true });
    await cli.close();
    expect(fatalMessage(err)).toBe('mongo-s3-mysql: load failed: *** with ***');
  });
});
