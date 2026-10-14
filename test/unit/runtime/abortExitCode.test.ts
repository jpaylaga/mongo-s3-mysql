import { describe, expect, it } from 'vitest';
import exitCodes from '../../../src/cli/exitCodes.js';
import abortExitCode from '../../../src/runtime/abortExitCode.js';

const aborted = (reason: unknown): AbortSignal => {
  const controller = new AbortController();
  controller.abort(reason);
  return controller.signal;
};

describe('abortExitCode', () => {
  it('maps SIGTERM to 143 and every other reason to 130', () => {
    expect(abortExitCode(aborted('SIGTERM'))).toBe(exitCodes.sigterm);
    expect(abortExitCode(aborted('SIGINT'))).toBe(exitCodes.sigint);
    expect(abortExitCode(aborted(new Error('lock lost')))).toBe(exitCodes.sigint);
    expect([exitCodes.sigterm, exitCodes.sigint]).toEqual([143, 130]);
  });
});
