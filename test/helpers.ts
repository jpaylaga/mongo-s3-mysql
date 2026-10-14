import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { onTestFinished } from 'vitest';
import parseConfig from '../src/config/parseConfig.js';
import createLayout from '../src/layout/createLayout.js';
import createContext from '../src/runtime/createContext.js';
import msmError from '../src/runtime/msmError.js';
import createMemoryStore from '../src/s3/createMemoryStore.js';
import type { CommandName, Config, MsmEvent, ObjectStore } from '../src/types.js';

/** The documented example config (docs/configuration.md), inline so the tests do not depend on the examples directory. */
export const exampleConfigJson = {
  mongo: { uriEnv: 'MSM_MONGO_URI', database: 'app' },
  s3: {
    bucket: 'example-archive-bucket',
    prefix: 'mongo-archive',
    partition: { account_id: '111122223333', region: 'us-east-1', cluster: 'example-cluster', database: 'app' },
    region: 'us-east-1',
  },
  mysql: { host: 'mysql.example.internal', user: 'archive_loader', database: 'archive', caFile: 'global-bundle.pem' },
  export: { batchPrefix: 'app-archive', concurrency: 4 },
  collections: [
    { name: 'audit_log', strategy: 'timestamp-window', field: 'created_at', window: 'day' },
    { name: 'orders', strategy: 'objectid-window', window: 'day' },
    { name: 'coupons', strategy: 'full-collection' },
  ],
};

export function exampleConfig(overrides: Record<string, unknown> = {}, baseDir = '/work'): Config {
  return parseConfig({ ...structuredClone(exampleConfigJson), ...overrides }, baseDir, 'example');
}

/** A context whose events are collected, a memory store and the matching layout. */
export function memoryContext(options: { command?: CommandName; config?: Config; signal?: AbortSignal; now?: () => Date } = {}) {
  const config = options.config ?? exampleConfig({ retry: { attempts: 3, baseDelayMs: 1, maxDelayMs: 2 } });
  const events: MsmEvent[] = [];
  const ctx = createContext({
    config, command: options.command ?? 'export', emit: (e) => { events.push(e); },
    signal: options.signal, now: options.now, secrets: ['hunter2'],
  });
  const store = createMemoryStore(config.s3.bucket);
  return { ctx, config, events, store, layout: createLayout(config.s3) };
}

/** A fresh temp directory, removed when the test that asked for it ends (one made outside a test is left to the OS). */
export async function tmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'msm-test-'));
  try {
    onTestFinished(() => rm(dir, { recursive: true, force: true }));
  } catch {
    // Not inside a test (a describe-level helper): nothing to hook the cleanup on.
  }
  return dir;
}

export const gz = (text: string): Buffer => gzipSync(Buffer.from(text, 'utf8'));

export const fixturePath = (name: string): string => join(import.meta.dirname, 'fixtures', name);

export const readFixture = (name: string): Promise<string> => readFile(fixturePath(name), 'utf8');

export const realShape = async (name: string): Promise<unknown> => JSON.parse(await readFixture(join('real-shape', name)));

/**
 * The memory store with the real S3 store's abort behaviour: every call through `withRetry` throws
 * `interrupted` once the signal is aborted, so a listing phase under SIGINT rejects instead of answering.
 */
export function refusingStore<T extends ObjectStore>(store: T, signal: AbortSignal): T {
  const refuse = (name: string) => { if (signal.aborted) throw msmError('interrupted', `${name}: interrupted`); };
  return {
    ...store,
    async putFile(key, path, opts) { refuse('putFile'); return store.putFile(key, path, opts); },
    async putText(key, body, contentType) { refuse('putText'); return store.putText(key, body, contentType); },
    async head(key) { refuse('head'); return store.head(key); },
    async getText(key, maxBytes) { refuse('getText'); return store.getText(key, maxBytes); },
    async getStream(key) { refuse('getStream'); return store.getStream(key); },
    async list(prefix, delimiter) { refuse('list'); return store.list(prefix, delimiter); },
  };
}
