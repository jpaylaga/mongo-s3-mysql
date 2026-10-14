import { beforeEach, describe, expect, it, vi } from 'vitest';
import { exampleConfig } from '../../helpers.js';

const state = vi.hoisted(() => ({ options: null as Record<string, unknown> | null, failWith: null as Error | null, closed: 0, pinged: 0 }));

vi.mock('mongodb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('mongodb')>();
  class MongoClient {
    constructor(public uri: string, options: Record<string, unknown>) { state.options = options; }
    async connect() { if (state.failWith) throw state.failWith; }
    db() { return { command: async () => { state.pinged += 1; return { ok: 1 }; } }; }
    async close() { state.closed += 1; }
  }
  return { ...actual, MongoClient };
});

const { default: createMongo } = await import('../../../src/mongo/createMongo.js');
const { MongoCompatibilityError, MongoNetworkError, MongoServerSelectionError } = await import('mongodb');

describe('createMongo', () => {
  beforeEach(() => { Object.assign(state, { options: null, failWith: null, closed: 0, pinged: 0 }); });

  it('connects with the raw-BSON client options, pings, and exposes the database', async () => {
    const handle = await createMongo(exampleConfig(), 'mongodb://127.0.0.1:27017/app');
    expect(state.options).toEqual({
      appName: 'mongo-s3-mysql', readPreference: 'secondaryPreferred', retryReads: true, retryWrites: false, maxPoolSize: 8,
      serverSelectionTimeoutMS: 30_000, promoteValues: false, promoteLongs: false, promoteBuffers: false, bsonRegExp: true,
    });
    expect(state.pinged).toBe(1);
    await handle.close();
    expect(state.closed).toBe(1);
  });

  it('turns the driver compatibility error into a fatal config error that keeps the driver\'s wire version, and closes the client', async () => {
    state.failWith = new MongoCompatibilityError('Server at mongo:27017 reports maximum wire version 7, but this version of the Node.js Driver requires at least 9 (MongoDB 4.4)');
    await expect(createMongo(exampleConfig(), 'mongodb://127.0.0.1:27017/app')).rejects.toMatchObject({
      msmCode: 'config', fatal: true, message: 'MongoDB 4.4+ or DocumentDB 5.0+ required: Server at mongo:27017 reports maximum wire version 7, but this version of the Node.js Driver requires at least 9 (MongoDB 4.4)',
    });
    expect(state.closed).toBe(1);
  });

  it('points a server selection failure at directConnection=true, the usual fix through a tunnel', async () => {
    state.failWith = new MongoServerSelectionError('Server selection timed out after 30000 ms', {} as never);
    await expect(createMongo(exampleConfig(), 'mongodb://127.0.0.1:27017/app')).rejects.toMatchObject({ msmCode: 'mongo', message: expect.stringContaining('add directConnection=true') });
    state.failWith = new MongoServerSelectionError('Server selection timed out after 30000 ms', {} as never);
    await expect(createMongo(exampleConfig(), 'mongodb://127.0.0.1:27017/app?directConnection=true')).rejects.toBeInstanceOf(MongoServerSelectionError);
  });

  it('propagates other connection errors unchanged', async () => {
    state.failWith = new MongoNetworkError('refused');
    await expect(createMongo(exampleConfig(), 'mongodb://127.0.0.1:1/app')).rejects.toBeInstanceOf(MongoNetworkError);
  });
});
