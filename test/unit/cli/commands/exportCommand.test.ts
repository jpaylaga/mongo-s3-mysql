import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import exportCommand from '#cli/commands/exportCommand';

const quiet = { writeErr: () => {}, writeOut: () => {} };

// commander copies exitOverride into subcommands made with .command(), not into ones passed to
// addCommand.
const program = () =>
  new Command()
    .name('mongo-s3-mysql')
    .exitOverride()
    .configureOutput(quiet)
    .option('-c, --config <path>', 'config file', '/nonexistent/mongo-s3-mysql.config.json')
    .option('-C, --collections <names>')
    .option('-y, --yes')
    .option('--json')
    .addCommand(exportCommand().exitOverride().configureOutput(quiet));

describe('exportCommand', () => {
  it('declares the documented flags', () => {
    const help = exportCommand().helpInformation();

    for (const flag of [
      '--batch-id <id>',
      '--since <iso|last>',
      '--cutoff <iso>',
      '--include-rest',
      '--dry-run',
    ])
      expect(help).toContain(flag);
  });

  it('rejects an unknown option before touching the config', async () => {
    await expect(program().parseAsync(['node', 'cli', 'export', '--reload'])).rejects.toThrow(
      /unknown option/
    );
  });

  it('a missing config file surfaces as an error rather than a silent default', async () => {
    await expect(
      program().parseAsync(['node', 'cli', 'export', '--since', 'last', '--dry-run'])
    ).rejects.toThrow(/nonexistent/);
  });
});
