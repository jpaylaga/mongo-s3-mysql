import { describe, expect, it, vi } from 'vitest';
import runChunks from '#load/runChunks';
import msmError from '#runtime/msmError';
import type { ChunkOutcome, LoadCandidate, LoadRun, LoadSelection } from '#types';
import { exampleConfig, memoryContext } from '../../helpers.js';
import { fakeMysql, header } from '../mysql/fakeMysql.js';
import type { Rule } from '../mysql/fakeMysql.js';
import { resolved, simpleMapping, simpleTable, target } from './fixtures.js';

// runChunks owns the loop; what one attempt does is loadChunk's business and is scripted here per
// run id.
const script = new Map<string, (attempt: number) => Promise<ChunkOutcome>>();

vi.mock('#load/loadChunk', () => ({
  default: async (_run: LoadRun, cand: LoadCandidate, attempt: number) =>
    (script.get(cand.resolved.runId) as (attempt: number) => Promise<ChunkOutcome>)(attempt),
}));

const cand = (runId: string): LoadCandidate => ({ resolved: resolved({ runId }), reload: false });

const done = (runId: string, docs = 1): ChunkOutcome => ({
  chunk: runId,
  collection: 'audit_log',
  status: 'done',
  docs,
});

function setup(rules: Rule[] = [], signal?: AbortSignal) {
  const config = exampleConfig({
    retry: { attempts: 2, baseDelayMs: 1, maxDelayMs: 2 },
    load: { concurrency: 2, chunkAttempts: 2 },
  });

  const { ctx, store, events } = memoryContext({ command: 'load', config, signal });
  const fake = fakeMysql(rules);

  const run: LoadRun = {
    ctx,
    store,
    mysql: fake.mysql,
    loadRunId: 'load-x',
    maxBatchBytes: 1,
    maxRowBytes: 1,
    targets: new Map([['audit_log', target(simpleMapping(), simpleTable())]]),
    locks: new Map(),
    batchCutoffs: new Map(),
  };

  const tableFor = () => 'audit_log_entries';

  return { run, events, tableFor, ...fake };
}

describe('runChunks', () => {
  it('loads batch after batch, counts the documents and reports progress', async () => {
    script.set('r1', async () => done('r1', 3));
    script.set('r2', async () => done('r2', 4));
    script.set('r3', async () => done('r3', 5));

    const { run, events, tableFor } = setup();

    const selections: LoadSelection[] = [
      { batch: { id: 'b1', cutoff: null }, candidates: [cand('r1'), cand('r2')], skipped: [] },
      { batch: { id: 'empty', cutoff: null }, candidates: [], skipped: [] },
      { batch: { id: 'b2', cutoff: null }, candidates: [cand('r3')], skipped: [] },
    ];

    const result = await runChunks(run, selections, new AbortController(), tableFor);

    expect(result).toEqual({
      outcomes: [done('r1', 3), done('r2', 4), done('r3', 5)],
      fatal: null,
      docs: 12,
    });

    expect(
      events.filter(e => e.type === 'info').map(e => (e as { message: string }).message)
    ).toEqual(['batch b1: loading 2 chunks', 'batch b2: loading 1 chunks']);

    expect(events.filter(e => e.type === 'progress').at(-1)).toMatchObject({
      done: 3,
      total: 3,
      docs: 12,
    });
  });

  it('a failed chunk is recorded in its ledger row; failing to record it only warns', async () => {
    const boom = Object.assign(new Error('Data too long for column hunter2'), {
      errno: 1406,
      sqlState: '22001',
    });

    script.set('bad', async () => {
      throw boom;
    });

    script.set('ok', async () => done('ok'));

    const marked: unknown[][] = [];

    const { run, events, tableFor } = setup([
      [
        /^UPDATE `_msm_load_chunks` SET `status` = 'failed'/,
        params => {
          marked.push(params);

          if (params[2] === 'ok') throw new Error('ledger gone');

          return header(1);
        },
      ],
    ]);

    const result = await runChunks(
      run,
      [{ batch: { id: 'b1', cutoff: null }, candidates: [cand('bad')], skipped: [] }],
      new AbortController(),
      tableFor
    );

    expect(result.fatal).toBeNull();

    expect(result.outcomes).toEqual([
      {
        chunk: 'bad',
        collection: 'audit_log',
        status: 'failed',
        code: 'mysql',
        error: 'Data too long for column ***',
      },
    ]);

    expect(marked).toEqual([['Data too long for column ***', 'audit_log_entries', 'bad']]);

    expect(
      events.filter(e => e.type === 'warn').map(e => (e as { message: string }).message)
    ).toEqual(['bad failed (mysql): Data too long for column ***']);

    script.set('ok', async () => {
      throw Object.assign(new Error('deadlock'), { errno: 1213, sqlState: '40001' });
    });

    const second = setup([
      [
        /^UPDATE `_msm_load_chunks` SET `status` = 'failed'/,
        () => {
          throw new Error('ledger gone');
        },
      ],
    ]);

    const r2 = await runChunks(
      second.run,
      [{ batch: { id: 'b1', cutoff: null }, candidates: [cand('ok')], skipped: [] }],
      new AbortController(),
      second.tableFor
    );

    expect(r2.outcomes[0]?.status).toBe('failed');

    expect(
      second.events.filter(e => e.type === 'warn').map(e => (e as { message: string }).message)
    ).toContain('ok: could not record the failure (ledger gone)');
  });

  it('a fatal error aborts the signal and is returned as fatal with earlier outcomes', async () => {
    const fatal = msmError('lock', 'lock on audit_log_entries lost', { fatal: true });
    const local = new AbortController();

    script.set('first', async () => {
      throw fatal;
    });

    script.set('second', async () => {
      await new Promise(resolve => {
        setTimeout(resolve, 5);
      });

      return local.signal.aborted
        ? { chunk: 'second', collection: 'audit_log', status: 'interrupted', code: 'interrupted' }
        : done('second');
    });

    const { run, tableFor } = setup();

    const result = await runChunks(
      run,
      [
        {
          batch: { id: 'b1', cutoff: null },
          candidates: [cand('first'), cand('second')],
          skipped: [],
        },
      ],
      local,
      tableFor
    );

    expect(result.fatal).toBe(fatal);
    expect(local.signal.aborted).toBe(true);
    expect(local.signal.reason).toBe(fatal);
    expect(result.outcomes.length).toBeLessThanOrEqual(1);
  });
});
