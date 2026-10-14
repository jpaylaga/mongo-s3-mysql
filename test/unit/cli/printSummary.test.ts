import { afterEach, describe, expect, it, vi } from 'vitest';
import printSummary from '#cli/printSummary';

describe('printSummary', () => {
  afterEach(() => vi.restoreAllMocks());

  it('prints one JSON document on stdout with --json and nothing else', () => {
    const out: string[] = [];

    vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => {
      out.push(String(s));

      return true;
    }) as never);

    const table = vi.spyOn(console, 'table').mockImplementation(() => undefined);

    printSummary({ exitCode: 0, outcomes: [] }, [{ chunk: 'x' }], true, 'run verify');
    expect(JSON.parse(out.join(''))).toEqual({ exitCode: 0, outcomes: [] });
    expect(table).not.toHaveBeenCalled();
  });

  it('prints a table and the next line otherwise', () => {
    const out: string[] = [];

    vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => {
      out.push(String(s));

      return true;
    }) as never);

    const table = vi.spyOn(console, 'table').mockImplementation(() => undefined);

    printSummary({}, [{ collection: 'a', done: 1 }], false, 'run verify');
    expect(table).toHaveBeenCalledWith([{ collection: 'a', done: 1 }]);
    expect(out).toEqual(['next: run verify\n']);
    printSummary({}, [], undefined, '');
    expect(table).toHaveBeenCalledTimes(1);
    expect(out).toHaveLength(1);
  });
});
