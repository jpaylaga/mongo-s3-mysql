import type { Command } from 'commander';
import envSecrets from '#cli/envSecrets';
import installSignalHandlers from '#cli/installSignalHandlers';
import parseList from '#cli/parseList';
import printEvent from '#cli/printEvent';
import runSecrets from '#cli/runSecrets';
import loadConfig from '#config/loadConfig';
import selectCollections from '#config/selectCollections';
import createMongo from '#mongo/createMongo';
import createMysql from '#mysql/createMysql';
import createContext from '#runtime/createContext';
import createS3Store from '#s3/createS3Store';
import type { CliContext, ClientNeeds, CommandName } from '#types';

const names: CommandName[] = ['inventory', 'export', 'verify', 'infer', 'load', 'reconcile'];

/**
 * The CLI's one place that reads env and process state: config file, env secrets, signal handlers
 * and only the clients the command needs. `close()` undoes all of it. The secrets it read are
 * recorded for the top-level catch in cli.ts, which may fire after this returned (a custom env name
 * would otherwise escape the conventional-name scan there).
 */
export default async function resolveContext(
  command: Command,
  needs: ClientNeeds
): Promise<CliContext> {
  const globals = command.optsWithGlobals<CliContext['globals']>();
  const name = command.name() as CommandName;

  if (!names.includes(name)) throw new Error(`unknown command ${name}`);

  const config = await loadConfig(globals.config);

  const uri = needs.mongo ? process.env[config.mongo.uriEnv] : undefined;

  if (needs.mongo && !uri)
    throw new Error(`config: set ${config.mongo.uriEnv} to the MongoDB connection string`);

  if (needs.mysql && config.mysql === undefined)
    throw new Error('config: the "mysql" section is required');

  const password = needs.mysql && config.mysql ? process.env[config.mysql.passwordEnv] : undefined;

  if (needs.mysql && config.mysql && password === undefined)
    throw new Error(`config: set ${config.mysql.passwordEnv} to the MySQL password`);

  const secrets = envSecrets([uri, password]);

  runSecrets.record(secrets);

  const controller = new AbortController();
  const emit = printEvent(globals.logFormat ?? 'text', secrets);

  const uninstall = installSignalHandlers(controller, message =>
    emit({ type: 'warn', command: name, message })
  );

  const ctx = createContext({ config, command: name, emit, signal: controller.signal, secrets });

  const collections = selectCollections(
    config,
    globals.collections === undefined ? undefined : parseList(globals.collections)
  );

  const result: CliContext = {
    ctx,
    collections,
    globals,
    async close() {
      uninstall();
      await Promise.allSettled([result.mongo?.close(), result.mysql?.close()]);
    },
  };

  try {
    if (needs.mongo && uri) result.mongo = await createMongo(config, uri);

    // The store's retry loop refuses every call once its signal is pulled, but export must still
    // write its final batch manifest after SIGINT; uploads abort through putFile's own per-call
    // signal.
    if (needs.s3)
      result.store = createS3Store(config.s3, { ...ctx, signal: new AbortController().signal });

    if (needs.mysql && config.mysql && password !== undefined) {
      const limit = name === 'load' ? config.load.concurrency + 2 : 2;

      result.mysql = await createMysql(config.mysql, password, limit);
    }
  } catch (err) {
    await result.close();

    throw err;
  }

  return result;
}
