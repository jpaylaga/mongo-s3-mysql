import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExportLedger, ExportLedgerEntry } from '#types';

/**
 * Every line records `counts_match: true`: a flagged chunk is never cached, and a line without it
 * is ignored on read.
 */
interface Line extends ExportLedgerEntry {
  run_id: string;
  counts_match: true;
  at: string;
}

/**
 * The local cache of committed chunk manifests: one JSON line per commit, appended and synced, so a
 * resume can skip the S3 reads for chunks this host already finished. S3 stays the truth: a missing
 * or torn file only costs the manifest reads, a line whose key or bucket is not the one the current
 * layout lists is ignored, and only `counts_match: true` lines count (a flagged chunk is pending).
 */
export default function createExportLedger(stateDir: string, batchId: string): ExportLedger {
  const dir = join(stateDir, 'export', batchId);
  const path = join(dir, 'completed.jsonl');

  return {
    async read() {
      const done = new Map<string, ExportLedgerEntry>();
      let text: string;

      try {
        text = await readFile(path, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return done;

        throw err;
      }

      for (const raw of text.split('\n')) {
        if (raw.trim() === '') continue;

        let line: Partial<Line>;

        try {
          line = JSON.parse(raw) as Partial<Line>;
        } catch {
          // A crash between write and sync leaves a torn tail; the chunk is simply re-checked on
          // S3.
          continue;
        }

        if (
          typeof line.run_id !== 'string' ||
          typeof line.manifest_sha256 !== 'string' ||
          typeof line.exported_count !== 'number'
        )
          continue;

        if (
          typeof line.manifest_key !== 'string' ||
          typeof line.bucket !== 'string' ||
          line.counts_match !== true
        )
          continue;

        done.set(line.run_id, {
          manifest_key: line.manifest_key,
          bucket: line.bucket,
          manifest_sha256: line.manifest_sha256,
          exported_count: line.exported_count,
        });
      }

      return done;
    },
    async append(runId, entry) {
      await mkdir(dir, { recursive: true });

      const line: Line = {
        run_id: runId,
        ...entry,
        counts_match: true,
        at: new Date().toISOString(),
      };

      const handle = await open(path, 'a');

      try {
        await handle.writeFile(`${JSON.stringify(line)}\n`, 'utf8');
        await handle.datasync();
      } finally {
        await handle.close();
      }
    },
  };
}
