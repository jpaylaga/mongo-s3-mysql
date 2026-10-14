import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import reconcileCommand from '#cli/commands/reconcileCommand';

const quiet = { writeErr: () => {}, writeOut: () => {} };

// commander copies exitOverride into subcommands made with .command(), not into ones passed to
// addCommand.
const program = () =>
  new Command()
    .name('mongo-s3-mysql')
    .exitOverride()
    .configureOutput(quiet)
    .option('-c, --config <path>', 'config file', 'mongo-s3-mysql.config.json')
    .option('-y, --yes')
    .option('--json')
    .addCommand(reconcileCommand().exitOverride().configureOutput(quiet));

describe('reconcileCommand', () => {
  it('declares the documented flags', () => {
    const help = reconcileCommand().helpInformation();

    for (const flag of ['--batch-id <ids>', '--deep', '--show-ok', '--ignore <kinds>'])
      expect(help).toContain(flag);

    expect(help).toContain('exit 4 on drift');
  });

  it('refuses an unknown --ignore kind before reading the config', async () => {
    await expect(
      program().parseAsync(['node', 'cli', 'reconcile', '--ignore', 'table_count,bogus'])
    ).rejects.toThrow(/--ignore: unknown drift kind bogus; known: not_loaded, load_incomplete/);
  });

  it('rejects an unknown option', async () => {
    await expect(program().parseAsync(['node', 'cli', 'reconcile', '--reload'])).rejects.toThrow(
      /unknown option/
    );
  });
});
