import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import inferCommand from '#cli/commands/inferCommand';

const quiet = { writeErr: () => {}, writeOut: () => {} };

/**
 * The global options that the command reads through `optsWithGlobals`, pointed at a config that
 * does not exist. Commander copies exitOverride into subcommands made with .command(), not into
 * addCommand ones.
 */
const program = () =>
  new Command()
    .name('mongo-s3-mysql')
    .exitOverride()
    .configureOutput(quiet)
    .option('-c, --config <path>', 'config file', '/nonexistent/mongo-s3-mysql.config.json')
    .option('-C, --collections <names>')
    .option('--json')
    .option('-y, --yes')
    .addCommand(inferCommand().exitOverride().configureOutput(quiet));

const parse = (...args: string[]) => program().parseAsync(['node', 'cli', 'infer', ...args]);

describe('inferCommand', () => {
  it('declares the documented flags with their defaults', () => {
    const help = inferCommand().helpInformation();

    for (const flag of [
      '--batch-id <id>',
      '--out <dir>',
      '--table <t>',
      '--key-column <c>',
      '--run-id-column <c>',
      '--chunk-column <c>',
      '--extra-column <c>',
      '--timezone <tz>',
      '--child-tables',
      '--force',
    ])
      expect(help).toContain(flag);

    expect(help).toContain('(default: "mongo_id")');
    expect(help).toContain('(default: "UTC")');
  });

  it('refuses an invalid column or table identifier before reading the config', async () => {
    await expect(parse('--key-column', 'mongo-id')).rejects.toThrow(
      /^--key-column "mongo-id": letters, digits, underscore; max 64$/
    );

    await expect(parse('--table', '1orders')).rejects.toThrow(/--table "1orders"/);
    await expect(parse('--run-id-column', 'a'.repeat(65))).rejects.toThrow(/--run-id-column/);
    await expect(parse('--chunk-column', '')).rejects.toThrow(/--chunk-column ""/);

    await expect(parse('--extra-column', 'extra.json')).rejects.toThrow(
      /--extra-column "extra.json"/
    );
  });

  it('refuses a time zone Intl does not know before reading the config', async () => {
    await expect(parse('--timezone', 'Mars/Olympus')).rejects.toThrow(
      /^--timezone "Mars\/Olympus": not an IANA time zone like "UTC" or "Asia\/Manila"$/
    );
  });

  it('reads the config only once the flags are valid', async () => {
    await expect(parse('--timezone', 'Asia/Manila', '--child-tables')).rejects.toThrow(
      /nonexistent/
    );
  });

  it('rejects an unknown option', async () => {
    await expect(parse('--create-tables')).rejects.toThrow(/unknown option/);
  });
});
