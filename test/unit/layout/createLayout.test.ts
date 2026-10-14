import { describe, expect, it } from 'vitest';
import createLayout from '#layout/createLayout';
import { exampleConfig } from '../../helpers.js';

const P = 'account_id=111122223333/region=us-east-1/cluster=example-cluster/database=app';
const win = { start: new Date('2026-03-02T00:00:00Z'), end: new Date('2026-03-03T00:00:00Z') };
const r = 'b-audit_log-timestamp-window-20260302T000000Z-20260303T000000Z';

describe('createLayout', () => {
  const layout = createLayout(exampleConfig().s3);

  it('builds the key templates (docs/how-it-works.md) with prefix and partition', () => {
    const raw = layout.rawPrefix('audit_log', win, r);
    const timeSegments = 'source_year=2026/source_month=03/source_day=02/source_hour=00';

    expect(raw).toBe(`mongo-archive/raw/${P}/collection=audit_log/${timeSegments}/run_id=${r}/`);

    expect(layout.part(raw, 1)).toBe(`${raw}part-000001.jsonl.gz`);
    expect(layout.part(raw, 1234567)).toBe(`${raw}part-1234567.jsonl.gz`);

    expect(layout.chunkManifest('audit_log', r)).toBe(
      `mongo-archive/manifests/${P}/collection=audit_log/run_id=${r}.json`
    );

    expect(layout.chunkManifestPrefix('audit_log', 'b')).toBe(
      `mongo-archive/manifests/${P}/collection=audit_log/run_id=b-audit_log-`
    );

    expect(layout.collectionsPrefix()).toBe(`mongo-archive/manifests/${P}/`);
    expect(layout.batchManifest('b')).toBe(`mongo-archive/manifests/${P}/run_id=b.json`);
    expect(layout.batchesPrefix()).toBe(`mongo-archive/manifests/${P}/run_id=`);

    expect(layout.counts('audit_log', r)).toBe(
      `mongo-archive/validation/${P}/collection=audit_log/run_id=${r}/counts.json`
    );

    expect(layout.parseCheck('audit_log', r)).toBe(
      `mongo-archive/validation/${P}/collection=audit_log/run_id=${r}/parse-check.json`
    );
  });

  it('uses all for the time segments of full-collection chunks', () => {
    const allTime = 'source_year=all/source_month=all/source_day=all/source_hour=all';

    expect(layout.rawPrefix('coupons', null, 'b-coupons-full-collection-full')).toBe(
      `mongo-archive/raw/${P}/collection=coupons/${allTime}/run_id=b-coupons-full-collection-full/`
    );
  });

  it('omits the prefix and partition slashes when they are empty', () => {
    const bare = createLayout(exampleConfig({ s3: { bucket: 'b-b-b' } }).s3);

    expect(bare.chunkManifest('c', 'r')).toBe('manifests/collection=c/run_id=r.json');

    expect(bare.rawPrefix('c', win, 'r')).toBe(
      'raw/collection=c/source_year=2026/source_month=03/source_day=02/source_hour=00/run_id=r/'
    );

    expect(bare.batchesPrefix()).toBe('manifests/run_id=');
    expect(bare.partition).toEqual({});

    const onlyPrefix = createLayout(exampleConfig({ s3: { bucket: 'b-b-b', prefix: 'x/y' } }).s3);

    expect(onlyPrefix.collectionsPrefix()).toBe('x/y/manifests/');
  });

  it('keeps partition order and converts between keys and uris', () => {
    const ordered = createLayout(
      exampleConfig({ s3: { bucket: 'b-b-b', partition: { zeta: '1', alpha: '2' } } }).s3
    );

    expect(ordered.batchManifest('b')).toBe('manifests/zeta=1/alpha=2/run_id=b.json');
    expect(layout.uri('a/b.gz')).toBe('s3://example-archive-bucket/a/b.gz');
    expect(layout.keyOf('s3://example-archive-bucket/a/b.gz')).toBe('a/b.gz');
    expect(layout.keyOf('s3://other-bucket/a/b.gz')).toBeNull();
    expect(layout.keyOf('s3://example-archive-bucket/')).toBeNull();
    expect(layout.bucket).toBe('example-archive-bucket');
  });

  it('uses the window start, hour included, for the raw time segments', () => {
    const hour = { start: new Date('2026-03-02T13:00:00Z'), end: new Date('2026-03-02T14:00:00Z') };

    expect(layout.rawPrefix('c', hour, 'r')).toContain('source_day=02/source_hour=13/');
  });
});
