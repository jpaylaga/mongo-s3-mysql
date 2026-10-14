import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import verifyCommand from '../../../../src/cli/commands/verifyCommand.js';

const quiet = { writeErr: () => {}, writeOut: () => {} };
const program = () => new Command().name('mongo-s3-mysql').exitOverride().configureOutput(quiet)
  .option('-c, --config <path>', 'config file', '/nonexistent/mongo-s3-mysql.config.json').option('-C, --collections <names>').option('-y, --yes').option('--json')
  .addCommand(verifyCommand().exitOverride().configureOutput(quiet));


describe('verifyCommand', () => {
  it('declares the documented flags', () => {
    const help = verifyCommand().helpInformation();
    for (const flag of ['--batch-id <ids>', '--all', '--no-write', '--dry-run']) expect(help).toContain(flag);
  });

  it('rejects an unknown option and surfaces a missing config file', async () => {
    await expect(program().parseAsync(['node', 'cli', 'verify', '--deep'])).rejects.toThrow(/unknown option/);
    await expect(program().parseAsync(['node', 'cli', 'verify', '--dry-run'])).rejects.toThrow(/nonexistent/);
  });
});
