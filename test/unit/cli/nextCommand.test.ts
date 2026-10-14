import { describe, expect, it } from 'vitest';
import defaultConfigPath from '#cli/defaultConfigPath';
import nextCommand from '#cli/nextCommand';

describe('nextCommand', () => {
  it('builds a full command line and repeats -c and -C only when the run was given them', () => {
    expect(nextCommand({}, 'verify')).toBe('mongo-s3-mysql verify');

    expect(nextCommand({ config: defaultConfigPath }, 'verify', ['--batch-id', 'b1'])).toBe(
      'mongo-s3-mysql verify --batch-id b1'
    );

    expect(nextCommand({ config: 'prod.json' }, 'load', ['--reload'])).toBe(
      'mongo-s3-mysql -c prod.json load --reload'
    );

    expect(nextCommand({ config: 'prod.json', collections: 'orders,coupons' }, 'reconcile')).toBe(
      'mongo-s3-mysql -c prod.json -C orders,coupons reconcile'
    );

    expect(nextCommand({ collections: 'orders' }, 'export', ['--dry-run'])).toBe(
      'mongo-s3-mysql -C orders export --dry-run'
    );
  });
});
