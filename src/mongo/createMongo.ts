import { MongoClient, MongoCompatibilityError, MongoServerSelectionError } from 'mongodb';
import msmError from '#runtime/msmError';
import type { Config, MongoHandle } from '#types';

/**
 * Connects with promotion off (wrappers survive to the export) and `retryWrites: false` (DocumentDB
 * rejects it). Below MongoDB 4.4 / DocumentDB 5.0 the driver throws its compatibility error,
 * reported as config. A server selection timeout after the seed answered usually means the
 * discovered replica set members are unreachable (a tunnel or port forward), which
 * `directConnection=true` in the URI avoids.
 */
export default async function createMongo(config: Config, uri: string): Promise<MongoHandle> {
  const client = new MongoClient(uri, {
    appName: 'mongo-s3-mysql',
    readPreference: config.mongo.readPreference,
    retryReads: true,
    retryWrites: false,
    maxPoolSize: config.export.concurrency + 4,
    serverSelectionTimeoutMS: 30_000,
    promoteValues: false,
    promoteLongs: false,
    promoteBuffers: false,
    bsonRegExp: true,
  });

  try {
    await client.connect();
    await client.db(config.mongo.database).command({ ping: 1 });
  } catch (err) {
    await client.close().catch(() => undefined);

    if (err instanceof MongoCompatibilityError) {
      throw msmError('config', `MongoDB 4.4+ or DocumentDB 5.0+ required: ${err.message}`, {
        cause: err,
        fatal: true,
      });
    }

    if (err instanceof MongoServerSelectionError && !/directConnection=true/i.test(uri)) {
      throw msmError(
        'mongo',
        `${err.message} (through a tunnel or port forward, add ` +
          'directConnection=true to the URI so the driver does not look for the ' +
          'other replica set members)',
        { cause: err, retriable: true }
      );
    }

    throw err;
  }

  return {
    client,
    db: client.db(config.mongo.database),
    close: () => client.close(),
  };
}
