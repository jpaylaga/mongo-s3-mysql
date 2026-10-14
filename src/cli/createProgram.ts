import { Command, Option } from 'commander';
import exportCommand from '#cli/commands/exportCommand';
import inferCommand from '#cli/commands/inferCommand';
import initCommand from '#cli/commands/initCommand';
import inventoryCommand from '#cli/commands/inventoryCommand';
import loadCommand from '#cli/commands/loadCommand';
import reconcileCommand from '#cli/commands/reconcileCommand';
import verifyCommand from '#cli/commands/verifyCommand';
import defaultConfigPath from '#cli/defaultConfigPath';
import toolVersion from '#runtime/toolVersion';

/** The whole command tree with the global flags; `cli.ts` parses it and prints the failure. */
export default function createProgram(): Command {
  return new Command()
    .name('mongo-s3-mysql')
    .description(
      'Archive MongoDB or DocumentDB collections to S3 as gzipped Extended JSON, ' +
        'then load them into your own MySQL tables'
    )
    .version(toolVersion.slice(toolVersion.lastIndexOf('@') + 1))
    .option('-c, --config <path>', 'config file', defaultConfigPath)
    .option(
      '-C, --collections <names>',
      'comma-separated collection names (default: the configured ones)'
    )
    .option('--json', 'print the result as one JSON document on stdout')
    .addOption(
      new Option('--log-format <format>', 'event lines on stderr')
        .choices(['text', 'json'])
        .default('text')
    )
    .option('-y, --yes', 'skip confirmation prompts')
    .option('--force-unlock', 'replace a lock left by a process that is gone')
    .addCommand(initCommand())
    .addCommand(inventoryCommand())
    .addCommand(exportCommand())
    .addCommand(verifyCommand())
    .addCommand(inferCommand())
    .addCommand(loadCommand())
    .addCommand(reconcileCommand());
}
