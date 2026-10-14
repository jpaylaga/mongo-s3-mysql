import { afterEach, describe, expect, it, vi } from 'vitest';
import installSignalHandlers from '../../../src/cli/installSignalHandlers.js';

describe('installSignalHandlers', () => {
  afterEach(() => vi.restoreAllMocks());

  it('aborts with the signal name on the first signal and exits on the second', () => {
    const before = process.listenerCount('SIGINT');
    const controller = new AbortController();
    const warnings: string[] = [];
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const uninstall = installSignalHandlers(controller, (m) => warnings.push(m));
    expect(process.listenerCount('SIGINT')).toBe(before + 1);

    process.emit('SIGTERM');
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBe('SIGTERM');
    expect(warnings[0]).toMatch(/SIGTERM received/);
    expect(exit).not.toHaveBeenCalled();

    process.emit('SIGINT');
    expect(exit).toHaveBeenCalledWith(130);
    process.emit('SIGTERM');
    expect(exit).toHaveBeenLastCalledWith(143);

    uninstall();
    expect(process.listenerCount('SIGINT')).toBe(before);
  });

  it('uses SIGINT as the reason for a first SIGINT', () => {
    const controller = new AbortController();
    const uninstall = installSignalHandlers(controller, () => undefined);
    process.emit('SIGINT');
    expect(controller.signal.reason).toBe('SIGINT');
    uninstall();
  });
});
