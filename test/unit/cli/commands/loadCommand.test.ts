import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import loadCommand from '#cli/commands/loadCommand';

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
    .addCommand(loadCommand().exitOverride().configureOutput(quiet));

describe('loadCommand', () => {
  it('declares the documented flags', () => {
    const help = loadCommand().helpInformation();

    for (const flag of [
      '--batch-id <ids>',
      '--create-tables',
      '--allow-unverified',
      '--allow-mismatch',
      '--allow-older',
      '--reload',
      '--load-run-id <id>',
      '--dry-run',
    ]) {
      expect(help).toContain(flag);
    }

    expect(help).toContain('resumable per chunk');
  });

  it('rejects an unknown option before touching the config', async () => {
    await expect(program().parseAsync(['node', 'cli', 'load', '--deep'])).rejects.toThrow(
      /unknown option/
    );
  });

  it('a missing config file surfaces as an error rather than a silent default', async () => {
    await expect(
      program().parseAsync([
        'node',
        'cli',
        '-c',
        '/nonexistent/mongo-s3-mysql.config.json',
        'load',
        '--dry-run',
      ])
    ).rejects.toThrow();
  });
});
