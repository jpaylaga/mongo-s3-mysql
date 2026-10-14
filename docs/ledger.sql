-- The load ledger of mongo-s3-mysql: the three tables `load` creates with CREATE TABLE IF NOT EXISTS the first time it runs.
-- A DBA can run this once and hand the loader a user without CREATE; drop the last statement when load.keyLedger is false.
-- Generated from src/mysql/ledgerDdl.ts; a unit test keeps the two equal.

CREATE TABLE IF NOT EXISTS `_msm_load_chunks` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, `target_table` VARCHAR(64) NOT NULL, `collection` VARCHAR(255) NOT NULL,
  `batch_id` VARCHAR(255) CHARACTER SET ascii NOT NULL, `chunk_run_id` VARCHAR(700) CHARACTER SET ascii NOT NULL,
  `batch_cutoff_utc` VARCHAR(32) NULL, `manifest_key` VARCHAR(1024) NOT NULL,
  `manifest_sha256` CHAR(64) CHARACTER SET ascii NOT NULL, `mapping_sha256` CHAR(64) CHARACTER SET ascii NOT NULL,
  `exported_count` BIGINT UNSIGNED NOT NULL, `lines_done` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `rows_inserted` BIGINT UNSIGNED NOT NULL DEFAULT 0, `rows_updated` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `duplicates_skipped` BIGINT UNSIGNED NOT NULL DEFAULT 0, `rows_rejected` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `cast_errors` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `status` ENUM('loading','loaded','failed') NOT NULL DEFAULT 'loading', `attempts` INT UNSIGNED NOT NULL DEFAULT 0,
  `load_run_id` VARCHAR(64) CHARACTER SET ascii NOT NULL, `error` TEXT NULL,
  `started_at` DATETIME(3) NOT NULL, `updated_at` DATETIME(3) NOT NULL, `finished_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`), UNIQUE KEY `uq_msm_chunk` (`target_table`, `chunk_run_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE IF NOT EXISTS `_msm_load_rejects` (
  `chunk_id` BIGINT UNSIGNED NOT NULL, `line_no` BIGINT UNSIGNED NOT NULL, `reason` VARCHAR(512) NOT NULL,
  `line_text` TEXT NOT NULL,
  `created_at` DATETIME(3) NOT NULL, PRIMARY KEY (`chunk_id`, `line_no`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE IF NOT EXISTS `_msm_load_keys` (
  `chunk_id` BIGINT UNSIGNED NOT NULL, `key_value` VARCHAR(760) NOT NULL,
  PRIMARY KEY (`chunk_id`, `key_value`), KEY `ix_msm_key` (`key_value`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
