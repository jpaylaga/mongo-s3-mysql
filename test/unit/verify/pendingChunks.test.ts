import { describe, expect, it } from 'vitest';
import listChunkManifests from '#layout/listChunkManifests';
import pendingChunks from '#verify/pendingChunks';
import { memoryContext } from '../../helpers.js';
import seedArchive, { lines, window } from './seedArchive.js';

const B = 'app-archive-full-20261013T020304Z';

describe('pendingChunks', () => {
  it('drops only chunks with a passing parse-check on the current body, unless --all', async () => {
    const { store, layout } = memoryContext({ command: 'verify' });
    const seed = seedArchive(store, layout);
    const verified = await seed.chunk({ collection: 'audit_log', batchId: B, lines: lines(2) });

    const failed = await seed.chunk({
      collection: 'audit_log',
      batchId: B,
      window: window('2026-03-03'),
      lines: lines(2, 3),
    });

    const stale = await seed.chunk({
      collection: 'audit_log',
      batchId: B,
      window: window('2026-03-04'),
      lines: lines(2, 5),
    });

    const broken = await seed.chunk({
      collection: 'audit_log',
      batchId: B,
      window: window('2026-03-05'),
      lines: lines(2, 7),
    });

    const fresh = await seed.chunk({
      collection: 'audit_log',
      batchId: B,
      window: window('2026-03-06'),
      lines: lines(2, 9),
    });

    const manifests = await listChunkManifests(store, layout, 'audit_log', B);
    const shaOf = (runId: string) => manifests.find(m => m.runId === runId)?.sha256 as string;

    const check = (runId: string, ok: boolean, sha: string) =>
      store.putText(
        layout.parseCheck('audit_log', runId),
        JSON.stringify({
          run_id: runId,
          collection: 'audit_log',
          mode: 'timestamp-window',
          gzip_test: true,
          first_line_parseable: true,
          first_line_has_id: true,
          manifest_only: false,
          ok,
          manifest_sha256: sha,
        }),
        'application/json'
      );

    await check(verified.runId, true, shaOf(verified.runId));
    await check(failed.runId, false, shaOf(failed.runId));
    await check(stale.runId, true, 'f'.repeat(64));

    await store.putText(
      layout.parseCheck('audit_log', broken.runId),
      '{ broken',
      'application/json'
    );

    const pending = await pendingChunks(store, layout, manifests, false);

    expect(pending.map(r => r.runId).sort()).toEqual(
      [failed.runId, stale.runId, broken.runId, fresh.runId].sort()
    );

    expect((await pendingChunks(store, layout, manifests, true)).map(r => r.runId)).toEqual(
      manifests.map(r => r.runId)
    );
  });
});
