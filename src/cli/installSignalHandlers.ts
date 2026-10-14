import exitCodes from './exitCodes.js';

/**
 * First SIGINT or SIGTERM aborts the controller with the signal name as reason, so chunks stop between
 * documents or batches and the exit code can tell the two apart. A second signal exits at once; everything
 * is resumable from the ledgers anyway. Returns the uninstaller.
 */
export default function installSignalHandlers(controller: AbortController, warn: (message: string) => void): () => void {
  let received = false;
  const handler = (signal: 'SIGINT' | 'SIGTERM') => {
    if (received) {
      process.exit(signal === 'SIGTERM' ? exitCodes.sigterm : exitCodes.sigint);
    }
    received = true;
    warn(`${signal} received: stopping after the current document or batch (send it again to exit now)`);
    controller.abort(signal);
  };
  const onInt = () => handler('SIGINT');
  const onTerm = () => handler('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  return () => {
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
  };
}
