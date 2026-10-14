import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { MongoDBContainer } from '@testcontainers/mongodb';
import { MySqlContainer } from '@testcontainers/mysql';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import parseConfig from '../../src/config/parseConfig.js';
import createMongo from '../../src/mongo/createMongo.js';
import createMysql from '../../src/mysql/createMysql.js';
import createContext from '../../src/runtime/createContext.js';
import createS3Store from '../../src/s3/createS3Store.js';
import type { ClientNeeds, CommandName, Config, MongoHandle, MsmEvent, MysqlHandle, ObjectStore } from '../../src/types.js';

// mongo, mysql and s3mock are pinned to the digests of the first green run (2026-10-14). The localstack fallback
// (docs/development.md) is pinned to a release that needs LOCALSTACK_AUTH_TOKEN, forwarded from the environment.
const images = {
  mongo: 'mongo:7@sha256:1f995ad6fdb93244a1addab1b58f934a0bc2f5643c38e02f5e9d7f0c7d227a7b',
  mysql: 'mysql:8.0@sha256:7dcddc01f13bab2f15cde676d44d01f61fc9f99fe7785e86196dfc07d358ae2b',
  s3mock: 'adobe/s3mock:latest@sha256:ab01a6946750f451ca215a47e91030695b260e4003b8a5a6201d25029b8fca92',
  localstack: 'localstack/localstack:latest@sha256:aa5632e041ca54ff61a0a25e17b1c898b09a1eb7f611bfc05f73ef53b7266872',
};

/** Distinctive passwords so the "no secret in the output" assertions cannot pass by accident; the Mongo one rides in the URI. */
export const mysqlPassword = 'e2e-mysql-pw-4f9c2b';
export const mongoPassword = 'e2e-mongo-pw-7d31a9';
export const mongoUser = 'msm';
export const database = 'app';
export const bucket = 'example-archive-bucket';

export interface Stack {
  mongoUri: string;
  mysql: { host: string; port: number; user: string; database: string };
  s3Endpoint: string;
  /** Directory holding the config file, state dir and mappings dir of this run. */
  workDir: string;
  configPath: string;
  /** Environment for a child CLI process: secrets and the S3 credentials the mock accepts. */
  env: NodeJS.ProcessEnv;
  config(overrides?: Record<string, unknown>): Config;
  stop(): Promise<void>;
}

async function startS3(): Promise<{ container: StartedTestContainer; endpoint: string }> {
  if (process.env.MSM_E2E_S3 === 'localstack') {
    const token = process.env.LOCALSTACK_AUTH_TOKEN;
    if (token === undefined || token === '') throw new Error('MSM_E2E_S3=localstack needs LOCALSTACK_AUTH_TOKEN: the pinned LocalStack release refuses to start without a license');
    const container = await new GenericContainer(images.localstack).withExposedPorts(4566).withEnvironment({ SERVICES: 's3', LOCALSTACK_AUTH_TOKEN: token })
      .withWaitStrategy(Wait.forLogMessage(/Ready\./)).start();
    return { container, endpoint: `http://${container.getHost()}:${container.getMappedPort(4566)}` };
  }
  const container = await new GenericContainer(images.s3mock).withExposedPorts(9090).withWaitStrategy(Wait.forListeningPorts()).start();
  return { container, endpoint: `http://${container.getHost()}:${container.getMappedPort(9090)}` };
}

/** The e2e config: the example partition, tiny parts and batches, rest chunks exported, no coupons mapping. */
export function configJson(stack: Pick<Stack, 'mysql' | 's3Endpoint'>, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mongo: { uriEnv: 'MSM_MONGO_URI', database },
    s3: {
      bucket, prefix: 'mongo-archive', region: 'us-east-1', endpoint: stack.s3Endpoint, forcePathStyle: true,
      partition: { account_id: '111122223333', region: 'us-east-1', cluster: 'example-cluster', database },
    },
    mysql: { host: stack.mysql.host, port: stack.mysql.port, user: stack.mysql.user, database: stack.mysql.database, tls: 'off' },
    export: { batchPrefix: 'app-archive', concurrency: 3, partMaxDocs: 40, keysetPageDocs: 15 },
    verify: { concurrency: 3 },
    infer: { minPresence: 0.02 },
    load: { concurrency: 3, batchRows: 7 },
    collections: [
      { name: 'audit_log', strategy: 'timestamp-window', field: 'created_at', window: 'day', rest: 'export' },
      { name: 'orders', strategy: 'objectid-window', window: 'day', rest: 'export' },
      { name: 'coupons', strategy: 'full-collection' },
    ],
    ...overrides,
  };
}

/** Starts MongoDB, MySQL and the S3 stand-in in parallel and writes the config file the CLI and the in-process runs share. */
export default async function startStack(): Promise<Stack> {
  const [mongo, mysql, s3] = await Promise.all([
    new MongoDBContainer(images.mongo).withUsername(mongoUser).withPassword(mongoPassword).start(),
    new MySqlContainer(images.mysql).withDatabase('archive').withUsername('archive_loader').withUserPassword(mysqlPassword).start(),
    startS3(),
  ]);
  // Any credentials satisfy the mock; the default chain in this process and in child CLIs reads these. A
  // developer's AWS_PROFILE would make the SDK skip them for the real profile, so it is dropped first.
  delete process.env.AWS_PROFILE;
  delete process.env.AWS_SESSION_TOKEN;
  process.env.AWS_ACCESS_KEY_ID = 'test';
  process.env.AWS_SECRET_ACCESS_KEY = 'test';
  process.env.AWS_REGION = 'us-east-1';
  const client = new S3Client({
    endpoint: s3.endpoint, forcePathStyle: true, region: 'us-east-1',
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
  });
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
  client.destroy();

  // Built by hand: with credentials set, getConnectionString() already carries a query string, so appending `/?...` would break it.
  const mongoUri = `mongodb://${mongoUser}:${mongoPassword}@${mongo.getHost()}:${mongo.getMappedPort(27017)}/?authSource=admin&directConnection=true`;
  const workDir = await mkdtemp(join(tmpdir(), 'msm-e2e-'));
  const stack: Stack = {
    mongoUri,
    mysql: { host: mysql.getHost(), port: mysql.getPort(), user: mysql.getUsername(), database: mysql.getDatabase() },
    s3Endpoint: s3.endpoint,
    workDir,
    configPath: join(workDir, 'mongo-s3-mysql.config.json'),
    env: { ...process.env, MSM_MONGO_URI: mongoUri, MSM_MYSQL_PASSWORD: mysqlPassword },
    config: (overrides = {}) => parseConfig(configJson(stack, overrides), workDir, 'e2e'),
    // The work directory (config, mappings, inferred files, tampered parts) goes with the containers; MSM_E2E_KEEP=1 keeps it for a look.
    stop: async () => {
      await Promise.allSettled([mongo.stop(), mysql.stop(), s3.container.stop()]);
      if (process.env.MSM_E2E_KEEP !== '1') await rm(workDir, { recursive: true, force: true });
    },
  };
  await writeFile(stack.configPath, `${JSON.stringify(configJson(stack), null, 2)}\n`);
  return stack;
}

export interface Clients { mongo?: MongoHandle; store?: ObjectStore; mysql?: MysqlHandle }

export interface ToolRun {
  ctx: ReturnType<typeof createContext>;
  events: MsmEvent[];
  controller: AbortController;
  clients: Clients;
  config: Config;
}

/**
 * Runs one command in-process the way resolveContext would, but with an injectable clock, a collected event
 * log and a handle on the abort controller, which the tests pull mid-run. Every client is closed afterwards.
 */
export async function runTool<T>(
  stack: Stack, command: CommandName, needs: ClientNeeds,
  options: { now?: Date; config?: Config; wrap?: (clients: Clients, controller: AbortController) => Clients },
  fn: (run: ToolRun) => Promise<T>,
): Promise<T & { events: MsmEvent[] }> {
  const config = options.config ?? stack.config();
  const controller = new AbortController();
  const events: MsmEvent[] = [];
  const now = options.now;
  const ctx = createContext({
    config, command, emit: (e) => { events.push(e); }, signal: controller.signal,
    now: now === undefined ? undefined : () => now, secrets: [mysqlPassword, mongoPassword],
  });
  let clients: Clients = {};
  try {
    if (needs.mongo) clients.mongo = await createMongo(config, stack.mongoUri);
    // The store never aborts on its own: final records must still land after SIGINT.
    if (needs.s3) clients.store = createS3Store(config.s3, { ...ctx, signal: new AbortController().signal });
    if (needs.mysql) clients.mysql = await createMysql(config.mysql as NonNullable<Config['mysql']>, mysqlPassword, (command === 'load' ? config.load.concurrency : 0) + 2);
    if (options.wrap) clients = options.wrap(clients, controller);
    const result = await fn({ ctx, events, controller, clients, config });
    return { ...result, events };
  } catch (err) {
    // The event log is the only trace of what the orchestrator did; a failing step prints it.
    process.stderr.write(`${command} events:\n${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
    throw err;
  } finally {
    await Promise.allSettled([clients.mongo?.close(), clients.mysql?.close()]);
  }
}
