import { describe, expect, it } from 'vitest';
import createProgram from '#cli/createProgram';

const quiet = { writeErr: () => {}, writeOut: () => {} };

describe('createProgram', () => {
  it('--help lists every command and the documented global flags', () => {
    const help = createProgram().helpInformation();

    for (const command of ['init', 'inventory', 'export', 'verify', 'infer', 'load', 'reconcile'])
      expect(help).toContain(`  ${command} `);

    for (const flag of [
      '-c, --config <path>',
      '-C, --collections <names>',
      '--json',
      '--log-format <format>',
      '-y, --yes',
      '--force-unlock',
    ])
      expect(help).toContain(flag);
  });

  it('refuses an unknown log format and an unknown command before any config is read', async () => {
    const program = () => createProgram().exitOverride().configureOutput(quiet);

    await expect(
      program().parseAsync(['node', 'cli', '--log-format', 'xml', 'verify'])
    ).rejects.toThrow(/Allowed choices are text, json/);

    await expect(program().parseAsync(['node', 'cli', 'frobnicate'])).rejects.toThrow(
      /unknown command/
    );
  });
});
