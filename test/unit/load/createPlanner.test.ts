import { describe, expect, it } from 'vitest';
import createPlanner from '#load/createPlanner';
import type { LoadTarget } from '#types';
import { memoryContext } from '../../helpers.js';
import seedArchive, { lines, sha256 } from '../verify/seedArchive.js';
import { batchId, ledgerRow, simpleMapping, simpleTable, target } from './fixtures.js';

async function archive() {
  const env = memoryContext({ command: 'load' });
  const seed = seedArchive(env.store, env.layout);
  const a = await seed.chunk({ collection: 'audit_log', batchId, lines: lines(3) });

  const b = await seed.chunk({
    collection: 'audit_log',
    batchId,
    mode: 'full-collection',
    tail: 'rest',
    lines: lines(2, 10),
  });

  const check = (runId: string, manifest: Record<string, unknown>, ok = true) =>
    env.store.putText(
      env.layout.parseCheck('audit_log', runId),
      JSON.stringify({
        run_id: runId,
        collection: 'audit_log',
        mode: 'timestamp-window',
        gzip_test: true,
        first_line_parseable: true,
        first_line_has_id: true,
        manifest_only: false,
        ok,
        manifest_sha256: sha256(JSON.stringify(manifest)),
      }),
      'application/json'
    );

  await check(a.runId, a.manifest);
  await check(b.runId, b.manifest);

  const targets = new Map<string, LoadTarget>([
    ['audit_log', target(simpleMapping(), simpleTable())],
  ]);

  const reads = { lists: 0, gets: 0 };
  const { list, getText } = env.store;

  env.store.list = async (prefix, delimiter) => {
    reads.lists += 1;

    return list.call(env.store, prefix, delimiter);
  };

  env.store.getText = async (key, max) => {
    reads.gets += 1;

    return getText.call(env.store, key, max);
  };

  return { ...env, a, b, targets, reads, check };
}

describe('createPlanner', () => {
  it('reads each manifest and parse-check once; a re-plan only needs a fresh ledger', async () => {
    const { store, layout, a, b, targets, reads } = await archive();

    const plan = createPlanner(
      store,
      layout,
      targets,
      [{ id: batchId, cutoff: '2026-10-13T01:00:00Z' }],
      { allowMismatch: false, allowUnverified: false, reload: false }
    );

    const first = await plan(new Map([['audit_log_entries', []]]));

    expect(first).toHaveLength(1);

    expect(first[0]?.candidates.map(c => c.resolved.runId).sort()).toEqual(
      [a.runId, b.runId].sort()
    );

    const after = { ...reads };

    expect(after.lists).toBe(1);
    expect(after.gets).toBe(4);

    // The ledger changed meanwhile: chunk a is loaded now. The second plan sees that without one
    // more S3 read.
    const second = await plan(
      new Map([
        [
          'audit_log_entries',
          [
            ledgerRow({
              chunk_run_id: a.runId,
              manifest_sha256: sha256(JSON.stringify(a.manifest)),
              exported_count: 3,
              lines_done: 3,
            }),
          ],
        ],
      ])
    );

    expect(second[0]?.candidates.map(c => c.resolved.runId)).toEqual([b.runId]);

    expect(second[0]?.skipped.map(s => [s.resolved.runId, s.severity])).toEqual([
      [a.runId, 'info'],
    ]);

    expect(reads).toEqual(after);
  });

  it('a damaged parse-check is unverified (null); a transient read error propagates', async () => {
    const { store, layout, a, b, targets } = await archive();

    await store.putText(layout.parseCheck('audit_log', a.runId), '{ broken', 'application/json');

    const plan = createPlanner(store, layout, targets, [{ id: batchId, cutoff: null }], {
      allowMismatch: false,
      allowUnverified: false,
      reload: false,
    });

    const [selection] = await plan(new Map());

    expect(selection?.candidates.map(c => c.resolved.runId)).toEqual([b.runId]);

    expect(selection?.skipped).toEqual([
      expect.objectContaining({
        resolved: expect.objectContaining({ runId: a.runId }),
        reason: 'unverified',
        severity: 'incomplete',
      }),
    ]);

    const failing = await archive();

    failing.store.getText = async key => {
      if (key.includes('parse-check'))
        throw Object.assign(new Error('InternalError'), {
          name: 'InternalError',
          $metadata: { httpStatusCode: 500 },
        });

      return store.getText(key);
    };

    const broken = createPlanner(
      failing.store,
      failing.layout,
      failing.targets,
      [{ id: batchId, cutoff: null }],
      { allowMismatch: false, allowUnverified: false, reload: false }
    );

    await expect(broken(new Map())).rejects.toMatchObject({ name: 'InternalError' });
  });
});
