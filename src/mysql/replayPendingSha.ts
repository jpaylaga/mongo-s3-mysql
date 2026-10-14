/**
 * The `manifest_sha256` the order guard writes into a newer chunk's ledger row before an older batch
 * touches its table. It can never equal a real manifest's sha256, so whatever run comes next
 * (a resume after an interrupt, a plain `load`) sees the manifest as changed and replays the chunk from
 * line 0: the obligation to replay survives the process that took it on.
 */
const replayPendingSha = 'replay-pending-'.padEnd(64, '0');

export default replayPendingSha;
