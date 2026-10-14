import { describe, expect, it } from 'vitest';
import { format } from 'mysql2';
import upsertSql from '../../../src/mysql/upsertSql.js';

const twinColumns = ['source_mongo_id', 'actor_id', 'description', 'data', 'ip_address', 'location', 'created_at', 'updated_at', 'backfill_run_id'];

describe('upsertSql', () => {
  it('produces the INSERT head and the ON DUPLICATE KEY UPDATE tail', () => {
    const { head, tail } = upsertSql('audit_log_entries', twinColumns, 'source_mongo_id');
    expect(head).toBe('INSERT INTO `audit_log_entries` (`source_mongo_id`,`actor_id`,`description`,`data`,`ip_address`,`location`,`created_at`,`updated_at`,`backfill_run_id`) VALUES ');
    expect(tail).toBe(' AS `_msm_new` ON DUPLICATE KEY UPDATE `actor_id` = `_msm_new`.`actor_id`, `description` = `_msm_new`.`description`, `data` = `_msm_new`.`data`, '
      + '`ip_address` = `_msm_new`.`ip_address`, `location` = `_msm_new`.`location`, `created_at` = `_msm_new`.`created_at`, `updated_at` = `_msm_new`.`updated_at`, '
      + '`backfill_run_id` = `_msm_new`.`backfill_run_id`');
  });

  it('joins with client-formatted tuples into one statement', () => {
    const { head, tail } = upsertSql('audit_log_entries', twinColumns, 'source_mongo_id');
    const tuple = format('(?,?,?,?,?,?,?,?,?)', ['65f1c0a1b2c3d4e5f6a7b8c9', 'tenant-a_1010', "User A-01 visited 'x'", '{"a":1}', '10.0.4.17', null, '2026-03-02 08:00:01', '2026-03-02 08:00:01', 'load-20261013T040000Z']);
    const sql = `${head}${tuple}${tail}`;
    expect(sql).toContain("VALUES ('65f1c0a1b2c3d4e5f6a7b8c9','tenant-a_1010','User A-01 visited \\'x\\'','{\\\"a\\\":1}','10.0.4.17',NULL,'2026-03-02 08:00:01','2026-03-02 08:00:01','load-20261013T040000Z') AS `_msm_new`");
  });

  it('prepends the key when it is not listed and never updates it', () => {
    const { head, tail } = upsertSql('orders', ['status', 'mongo_id', '_extra'], 'mongo_id');
    expect(head).toBe('INSERT INTO `orders` (`status`,`mongo_id`,`_extra`) VALUES ');
    expect(tail).toBe(' AS `_msm_new` ON DUPLICATE KEY UPDATE `status` = `_msm_new`.`status`, `_extra` = `_msm_new`.`_extra`');
    expect(upsertSql('orders', ['status'], 'mongo_id').head).toBe('INSERT INTO `orders` (`mongo_id`,`status`) VALUES ');
  });

  it('falls back to a no-op assignment when only the key is written', () => {
    const { tail } = upsertSql('t', ['k'], 'k');
    expect(tail).toBe(' AS `_msm_new` ON DUPLICATE KEY UPDATE `k` = `t`.`k`');
  });

  it('uses another alias for a table that takes the usual one, since MySQL refuses an alias equal to the table name', () => {
    const { tail } = upsertSql('_msm_new', ['k', 'v'], 'k');
    expect(tail).toBe(' AS `_msm_new2` ON DUPLICATE KEY UPDATE `v` = `_msm_new2`.`v`');
    expect(upsertSql('_MSM_NEW', ['k', 'v'], 'k').tail).toContain('AS `_msm_new2`');
  });

  it('quotes identifiers and refuses invalid ones', () => {
    expect(upsertSql('we`ird', ['a`b'], 'a`b').head).toBe('INSERT INTO `we``ird` (`a``b`) VALUES ');
    expect(() => upsertSql('', ['a'], 'a')).toThrow(/invalid MySQL identifier/);
  });
});
