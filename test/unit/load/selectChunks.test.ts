import { describe, expect, it } from 'vitest';
import selectChunks from '#load/selectChunks';
import type { ParseCheckRecord, ResolvedManifest, SelectOptions } from '#types';
import { ledgerRow, manifestSha, mappingSha, parseCheck, resolved } from './fixtures.js';

const opts = (over: Partial<SelectOptions> = {}): SelectOptions => ({
  allowMismatch: false,
  allowUnverified: false,
  reload: false,
  ...over,
});

const checksFor = (
  ...pairs: [ResolvedManifest, ParseCheckRecord | null][]
): Map<string, ParseCheckRecord | null> => new Map(pairs.map(([r, c]) => [r.runId, c]));

const verified = (r: ResolvedManifest) => checksFor([r, parseCheck(r)]);
const otherSha = 'c'.repeat(64);

describe('selectChunks', () => {
  it('returns nothing for no manifests', () => {
    expect(selectChunks([], new Map(), [ledgerRow()], mappingSha, opts())).toEqual({
      candidates: [],
      skipped: [],
    });
  });

  it('a verified, matching chunk with no ledger row is a fresh candidate', () => {
    const r = resolved();

    expect(selectChunks([r], verified(r), [], mappingSha, opts())).toEqual({
      candidates: [{ resolved: r, reload: false }],
      skipped: [],
    });
  });

  it('an unchanged loaded row is "already loaded" (info), even when its counts mismatched', () => {
    const r = resolved({ manifest: { counts_match: false } });
    const out = selectChunks([r], new Map(), [ledgerRow()], mappingSha, opts());

    expect(out.candidates).toEqual([]);
    expect(out.skipped).toEqual([{ resolved: r, reason: 'already loaded', severity: 'info' }]);
  });

  it('--reload turns an already loaded chunk into a candidate flagged reload', () => {
    const r = resolved();

    expect(
      selectChunks([r], verified(r), [ledgerRow()], mappingSha, opts({ reload: true }))
    ).toEqual({ candidates: [{ resolved: r, reload: true }], skipped: [] });
  });

  it('--reload does not bypass the mismatch and verification gates', () => {
    const r = resolved({ manifest: { counts_match: false } });

    expect(
      selectChunks([r], verified(r), [ledgerRow()], mappingSha, opts({ reload: true })).skipped[0]
    ).toMatchObject({ reason: 'counts did not match at export', severity: 'incomplete' });

    const s = resolved();

    expect(
      selectChunks([s], new Map(), [ledgerRow()], mappingSha, opts({ reload: true })).skipped[0]
    ).toMatchObject({ reason: 'unverified', severity: 'incomplete' });
  });

  it('counts_match false is skipped as incomplete unless --allow-mismatch', () => {
    const r = resolved({ manifest: { counts_match: false } });

    expect(selectChunks([r], verified(r), [], mappingSha, opts()).skipped).toEqual([
      { resolved: r, reason: 'counts did not match at export', severity: 'incomplete' },
    ]);

    expect(
      selectChunks([r], verified(r), [], mappingSha, opts({ allowMismatch: true })).candidates
    ).toEqual([{ resolved: r, reload: false }]);
  });

  it('the mismatch rule is checked before verification', () => {
    const r = resolved({ manifest: { counts_match: false } });

    expect(selectChunks([r], new Map(), [], mappingSha, opts()).skipped[0]?.reason).toBe(
      'counts did not match at export'
    );
  });

  it.each<[string, (r: ResolvedManifest) => Map<string, ParseCheckRecord | null>]>([
    ['no entry', () => new Map()],
    ['a null entry', r => checksFor([r, null])],
    ['ok false', r => checksFor([r, parseCheck(r, { ok: false })])],
    ['ok missing', r => checksFor([r, parseCheck(r, { ok: undefined })])],
    ['another manifest sha256', r => checksFor([r, parseCheck(r, { manifest_sha256: otherSha })])],
    ['no manifest sha256', r => checksFor([r, parseCheck(r, { manifest_sha256: undefined })])],
  ])(
    'a parse-check with %s means unverified: skipped as incomplete unless --allow-unverified',
    (_, checks) => {
      const r = resolved();

      expect(selectChunks([r], checks(r), [], mappingSha, opts()).skipped).toEqual([
        { resolved: r, reason: 'unverified', severity: 'incomplete' },
      ]);

      expect(
        selectChunks([r], checks(r), [], mappingSha, opts({ allowUnverified: true })).candidates
      ).toEqual([{ resolved: r, reload: false }]);
    }
  );

  it('a loaded row with a changed manifest is skipped as incomplete; --reload reloads it', () => {
    const r = resolved({ sha256: otherSha });
    const checks = checksFor([r, parseCheck(r)]);

    expect(selectChunks([r], checks, [ledgerRow()], mappingSha, opts()).skipped).toEqual([
      { resolved: r, reason: 'manifest changed after load; pass --reload', severity: 'incomplete' },
    ]);

    expect(selectChunks([r], checks, [ledgerRow()], mappingSha, opts({ reload: true }))).toEqual({
      candidates: [{ resolved: r, reload: true }],
      skipped: [],
    });
  });

  it('a loaded row with another mapping is only a warning; --reload reloads it', () => {
    const r = resolved();

    expect(selectChunks([r], verified(r), [ledgerRow()], otherSha, opts()).skipped).toEqual([
      { resolved: r, reason: 'loaded with another mapping; pass --reload', severity: 'warn' },
    ]);

    expect(selectChunks([r], verified(r), [ledgerRow()], otherSha, opts({ reload: true }))).toEqual(
      { candidates: [{ resolved: r, reload: true }], skipped: [] }
    );
  });

  it('when both the manifest and the mapping changed, the manifest rule wins', () => {
    const r = resolved({ sha256: otherSha });

    expect(
      selectChunks([r], checksFor([r, parseCheck(r)]), [ledgerRow()], otherSha, opts()).skipped[0]
        ?.reason
    ).toBe('manifest changed after load; pass --reload');
  });

  it.each(['loading', 'failed'] as const)(
    'a %s row is resumed as a non-reload candidate whatever its shas say',
    status => {
      const r = resolved();

      const rows = [
        ledgerRow({ status, manifest_sha256: otherSha, mapping_sha256: otherSha, lines_done: 10 }),
      ];

      expect(selectChunks([r], verified(r), rows, mappingSha, opts())).toEqual({
        candidates: [{ resolved: r, reload: false }],
        skipped: [],
      });
    }
  );

  it('matches ledger rows by chunk run id, keeps manifest order, each in exactly one list', () => {
    const a = resolved({ runId: 'b-audit_log-timestamp-window-20260301T000000Z-20260302T000000Z' });
    const b = resolved();

    const c = resolved({
      runId: 'b-audit_log-full-collection-rest',
      manifest: { counts_match: false },
    });

    const d = resolved({
      runId: 'b-audit_log-manifest-only-full',
      manifest: { mode: 'manifest-only', exported_count: 0, source_count: 0 },
    });

    const checks = checksFor(
      [a, parseCheck(a)],
      [b, parseCheck(b)],
      [c, parseCheck(c)],
      [d, parseCheck(d)]
    );

    const out = selectChunks(
      [a, b, c, d],
      checks,
      [ledgerRow({ chunk_run_id: b.runId }), ledgerRow({ id: 2, chunk_run_id: 'unrelated-chunk' })],
      mappingSha,
      opts()
    );

    expect(out.candidates.map(x => x.resolved.runId)).toEqual([a.runId, d.runId]);

    expect(out.skipped.map(s => [s.resolved.runId, s.reason])).toEqual([
      [b.runId, 'already loaded'],
      [c.runId, 'counts did not match at export'],
    ]);

    expect(out.candidates.length + out.skipped.length).toBe(4);
  });

  it('a parse-check pins the exact manifest body: only an identical sha string verifies it', () => {
    const r = resolved({ sha256: manifestSha });

    expect(
      selectChunks(
        [r],
        checksFor([r, parseCheck(r, { manifest_sha256: manifestSha })]),
        [],
        mappingSha,
        opts()
      ).candidates
    ).toHaveLength(1);

    expect(
      selectChunks(
        [r],
        checksFor([r, parseCheck(r, { manifest_sha256: manifestSha.toUpperCase() })]),
        [],
        mappingSha,
        opts()
      ).candidates
    ).toHaveLength(0);
  });
});
