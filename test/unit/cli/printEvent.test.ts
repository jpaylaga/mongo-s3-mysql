import { afterEach, describe, expect, it, vi } from 'vitest';
import printEvent from '#cli/printEvent';

describe('printEvent', () => {
  afterEach(() => vi.restoreAllMocks());

  const capture = () => {
    const lines: string[] = [];

    vi.spyOn(process.stderr, 'write').mockImplementation(((s: string) => {
      lines.push(String(s));

      return true;
    }) as never);

    return lines;
  };

  it('formats each event type as one redacted text line on stderr', () => {
    const lines = capture();
    const sink = printEvent('text', ['hunter2']);

    sink({ type: 'info', command: 'export', message: 'planning' });
    sink({ type: 'warn', command: 'export', message: 'uri mongodb://u:hunter2@h' });

    sink({
      type: 'chunk',
      command: 'export',
      chunk: 'b-c-full-collection-full',
      status: 'done',
      detail: '48,211 docs, 2.6 MB (5.1s)',
    });

    sink({
      type: 'retry',
      command: 'export',
      source: 's3',
      name: 'putFile',
      attempt: 3,
      delayMs: 4200,
      error: 'SlowDown',
    });

    sink({ type: 'progress', command: 'load', done: 3, total: 1200, docs: 48211 });

    expect(lines).toEqual([
      'planning\n',
      'warning: uri mongodb://***@h\n',
      '[b-c-full-collection-full] done 48,211 docs, 2.6 MB (5.1s)\n',
      'retry s3 putFile attempt 3 in 4.2s: SlowDown\n',
      'progress 3/1,200 chunks, 48,211 docs\n',
    ]);
  });

  it('emits JSON lines in json format, redacted', () => {
    const lines = capture();

    printEvent('json', ['hunter2'])({
      type: 'warn',
      command: 'verify',
      message: 'password hunter2',
    });

    expect(JSON.parse(lines[0] as string)).toEqual({
      type: 'warn',
      command: 'verify',
      message: 'password ***',
    });
  });

  it('redacts each field before serializing, so awkward secrets stay masked and JSON valid', () => {
    const lines = capture();

    printEvent('json', ['pa"ss\\word'])({
      type: 'warn',
      command: 'load',
      message: 'connect failed for pa"ss\\word',
    });

    expect(JSON.parse(lines[0] as string)).toEqual({
      type: 'warn',
      command: 'load',
      message: 'connect failed for ***',
    });

    printEvent('json', ['type'])({ type: 'warn', command: 'load', message: 'x' });
    expect(JSON.parse(lines[1] as string)).toEqual({ type: 'warn', command: 'load', message: 'x' });
    printEvent('json', ['","'])({ type: 'warn', command: 'load', message: 'x' });
    expect(JSON.parse(lines[2] as string)).toEqual({ type: 'warn', command: 'load', message: 'x' });
  });

  it('escapes control characters in text mode, so archive text cannot drive the terminal', () => {
    const lines = capture();

    printEvent(
      'text',
      []
    )({ type: 'warn', command: 'reconcile', message: 'key \u001b]0;pwned\u0007 (chunk)' });

    expect(lines[0]).toBe('warning: key \\u001b]0;pwned\\u0007 (chunk)\n');
    printEvent('text', [])({ type: 'info', command: 'load', message: 'tab\tand newline\nstay' });
    expect(lines[1]).toBe('tab\tand newline\nstay\n');
  });

  it('guards stderr and stdout against EPIPE, so a closed log pipe never kills a run', () => {
    printEvent('text', []);
    expect(process.stderr.listenerCount('error')).toBeGreaterThan(0);
    expect(process.stdout.listenerCount('error')).toBeGreaterThan(0);
  });
});
