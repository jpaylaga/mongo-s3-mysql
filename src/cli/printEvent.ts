import formatCount from '../runtime/formatCount.js';
import redact from '../runtime/redact.js';
import type { EventSink, MsmEvent } from '../types.js';
import escapeControl from './escapeControl.js';
import escapeJsonControl from './escapeJsonControl.js';

function line(e: MsmEvent): string {
  switch (e.type) {
    case 'info': return e.message;
    case 'warn': return `warning: ${e.message}`;
    case 'chunk': return `[${e.chunk}] ${e.status}${e.detail ? ` ${e.detail}` : ''}`;
    case 'retry': return `retry ${e.source} ${e.name} attempt ${e.attempt} in ${(e.delayMs / 1000).toFixed(1)}s: ${e.error}`;
    case 'progress': return `progress ${formatCount(e.done)}/${formatCount(e.total)} chunks, ${formatCount(e.docs)} docs`;
  }
}

/** Every string field redacted on its own, before serialization: JSON escaping would otherwise hide a secret with a quote or backslash in it. */
const redactFields = (event: MsmEvent, secrets: readonly string[]): MsmEvent =>
  Object.fromEntries(Object.entries(event).map(([k, v]) => [k, typeof v === 'string' ? redact(v, secrets) : v])) as MsmEvent;

let sinkGuarded = false;

/**
 * A closed stderr or stdout pipe (`2>&1 | head`, a log shipper that exited) raises EPIPE on the next write;
 * unhandled, it would kill the run mid-chunk and skip the batch manifest rewrite and the lock release.
 */
function guardSinks(): void {
  if (sinkGuarded) return;
  sinkGuarded = true;
  for (const stream of [process.stdout, process.stderr]) stream.on('error', () => undefined);
}

/** Events go to stderr, redacted, one line each; `json` emits the event object itself as a JSON line (C1 controls escaped too). */
export default function printEvent(format: 'text' | 'json', secrets: readonly string[]): EventSink {
  guardSinks();
  return (event) => {
    const text = format === 'json' ? escapeJsonControl(JSON.stringify(redactFields(event, secrets))) : escapeControl(redact(line(event), secrets));
    process.stderr.write(`${text}\n`);
  };
}
