import { describe, expect, it } from 'vitest';
import ledgerDdl from '#mysql/ledgerDdl';

describe('ledgerDdl', () => {
  it('creates the three ledger tables, key ledger last', () => {
    expect(ledgerDdl).toHaveLength(3);

    expect(ledgerDdl.map(s => /CREATE TABLE IF NOT EXISTS `(\w+)`/.exec(s)?.[1])).toEqual([
      '_msm_load_chunks',
      '_msm_load_rejects',
      '_msm_load_keys',
    ]);

    for (const s of ledgerDdl) {
      expect(s).toMatch(/ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin$/);
      expect(s).not.toContain(';');
      expect(s).not.toMatch(/--/);
    }
  });

  it('pins the columns the load and reconcile code rely on', () => {
    const chunks = ledgerDdl[0] as string;

    for (const column of [
      'id',
      'target_table',
      'collection',
      'batch_id',
      'chunk_run_id',
      'batch_cutoff_utc',
      'manifest_key',
      'manifest_sha256',
      'mapping_sha256',
      'exported_count',
      'lines_done',
      'rows_inserted',
      'rows_updated',
      'duplicates_skipped',
      'rows_rejected',
      'cast_errors',
      'status',
      'attempts',
      'load_run_id',
      'error',
      'started_at',
      'updated_at',
      'finished_at',
    ]) {
      expect(chunks).toContain(`\`${column}\``);
    }

    expect(chunks).toContain(
      "`status` ENUM('loading','loaded','failed') NOT NULL DEFAULT 'loading'"
    );

    expect(chunks).toContain('`chunk_run_id` VARCHAR(700) CHARACTER SET ascii NOT NULL');
    expect(chunks).toContain('UNIQUE KEY `uq_msm_chunk` (`target_table`, `chunk_run_id`)');

    const rejects = ledgerDdl[1] as string;

    expect(rejects).toContain('`reason` VARCHAR(512) NOT NULL');
    expect(rejects).toContain('`line_text` TEXT NOT NULL');
    expect(rejects).toContain('PRIMARY KEY (`chunk_id`, `line_no`)');

    const keys = ledgerDdl[2] as string;

    expect(keys).toContain('`key_value` VARCHAR(760) NOT NULL');
    expect(keys).toContain('PRIMARY KEY (`chunk_id`, `key_value`), KEY `ix_msm_key` (`key_value`)');
  });
});
