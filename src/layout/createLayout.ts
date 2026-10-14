import type { Layout, S3Config } from '#types';

const pad2 = (n: number) => String(n).padStart(2, '0');

/** The one S3 layout: the real exporter's key templates, nothing versioned, nothing adapted. */
export default function createLayout(s3: S3Config): Layout {
  const bucket = s3.bucket;
  const partition: Record<string, string> = { ...s3.partition };
  const p = s3.prefix ? `${s3.prefix}/` : '';

  const segments = Object.entries(partition)
    .map(([k, v]) => `${k}=${v}`)
    .join('/');

  const base = (area: 'raw' | 'manifests' | 'validation') =>
    `${p}${area}/${segments ? `${segments}/` : ''}`;

  const uriBase = `s3://${bucket}/`;

  return {
    bucket,
    partition,
    rawPrefix(collection, window, runId) {
      const time =
        window === null
          ? 'source_year=all/source_month=all/source_day=all/source_hour=all'
          : `source_year=${window.start.getUTCFullYear()}` +
            `/source_month=${pad2(window.start.getUTCMonth() + 1)}` +
            `/source_day=${pad2(window.start.getUTCDate())}` +
            `/source_hour=${pad2(window.start.getUTCHours())}`;

      return `${base('raw')}collection=${collection}/${time}/run_id=${runId}/`;
    },
    part: (rawPrefix, n) => `${rawPrefix}part-${String(n).padStart(6, '0')}.jsonl.gz`,
    chunkManifest: (collection, runId) =>
      `${base('manifests')}collection=${collection}/run_id=${runId}.json`,
    chunkManifestPrefix: (collection, batchId) =>
      `${base('manifests')}collection=${collection}/run_id=${batchId}-${collection}-`,
    collectionsPrefix: () => base('manifests'),
    batchManifest: batchId => `${base('manifests')}run_id=${batchId}.json`,
    batchesPrefix: () => `${base('manifests')}run_id=`,
    counts: (collection, runId) =>
      `${base('validation')}collection=${collection}/run_id=${runId}/counts.json`,
    parseCheck: (collection, runId) =>
      `${base('validation')}collection=${collection}/run_id=${runId}/parse-check.json`,
    uri: key => `${uriBase}${key}`,
    keyOf: uri =>
      uri.startsWith(uriBase) && uri.length > uriBase.length ? uri.slice(uriBase.length) : null,
  };
}
