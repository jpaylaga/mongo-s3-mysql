import { Command, Option } from 'commander';
import toolVersion from '../runtime/toolVersion.js';
import exportCommand from './commands/exportCommand.js';
import defaultConfigPath from './defaultConfigPath.js';
import inferCommand from './commands/inferCommand.js';
import initCommand from './commands/initCommand.js';
import inventoryCommand from './commands/inventoryCommand.js';
import loadCommand from './commands/loadCommand.js';
import reconcileCommand from './commands/reconcileCommand.js';
import verifyCommand from './commands/verifyCommand.js';

/** The whole command tree with the global flags; `cli.ts` parses it and prints the failure. */
export default function createProgram(): Command {
  return new Command()
    .name('mongo-s3-mysql')
    .description('Archive MongoDB or DocumentDB collections to S3 as gzipped Extended JSON, then load them into your own MySQL tables')
    .version(toolVersion.slice(toolVersion.lastIndexOf('@') + 1))
    .option('-c, --config <path>', 'config file', defaultConfigPath)
    .option('-C, --collections <names>', 'comma-separated collection names (default: the configured ones)')
    .option('--json', 'print the result as one JSON document on stdout')
    .addOption(new Option('--log-format <format>', 'event lines on stderr').choices(['text', 'json']).default('text'))
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
