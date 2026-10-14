/**
 * The application's own table: a surrogate id, a nullable UNIQUE `source_mongo_id` beside it and a
 * `backfill_run_id`, so imported rows dedupe on the Mongo id while live rows keep both NULL. Loaded
 * with no change.
 */
const twinDdl = `CREATE TABLE \`audit_log_entries\` (
  \`id\` bigint unsigned NOT NULL AUTO_INCREMENT,
  \`actor_id\` varchar(255) NOT NULL,
  \`description\` text NOT NULL,
  \`data\` json DEFAULT NULL,
  \`ip_address\` varchar(45) DEFAULT NULL,
  \`location\` json DEFAULT NULL,
  \`created_at\` timestamp NULL DEFAULT NULL,
  \`updated_at\` timestamp NULL DEFAULT NULL,
  \`source_mongo_id\` char(24) DEFAULT NULL,
  \`backfill_run_id\` varchar(64) DEFAULT NULL,
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`uq_ale_source_mongo_id\` (\`source_mongo_id\`),
  KEY \`idx_ale_actor_id\` (\`actor_id\`),
  KEY \`idx_ale_created_at\` (\`created_at\`),
  KEY \`idx_actor_id_created_at\` (\`actor_id\`, \`created_at\`),
  KEY \`idx_ale_actor_desc_created_id\` (\`actor_id\`, \`description\`(100), \`created_at\`, \`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`;

export default twinDdl;
