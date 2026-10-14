import { describe, expect, it } from 'vitest';
import createContext from '../../../src/runtime/createContext.js';
import type { MsmEvent } from '../../../src/types.js';
import { exampleConfig } from '../../helpers.js';

describe('createContext', () => {
  it('fills defaults: silent emit, a never-aborting signal, wall clock, no secrets', () => {
    const ctx = createContext({ config: exampleConfig(), command: 'verify' });
    expect(ctx.command).toBe('verify');
    expect(ctx.signal.aborted).toBe(false);
    expect(ctx.secrets).toEqual([]);
    expect(() => ctx.emit({ type: 'info', command: 'verify', message: 'x' })).not.toThrow();
    expect(Math.abs(ctx.now().getTime() - Date.now())).toBeLessThan(1000);
  });

  it('passes the given sink, signal, clock and secrets through', () => {
    const events: MsmEvent[] = [];
    const controller = new AbortController();
    const fixed = new Date('2026-10-13T00:00:00Z');
    const ctx = createContext({ config: exampleConfig(), command: 'load', emit: (e) => events.push(e), signal: controller.signal, now: () => fixed, secrets: ['x'] });
    ctx.emit({ type: 'warn', command: 'load', message: 'hi' });
    controller.abort();
    expect(events).toHaveLength(1);
    expect(ctx.signal.aborted).toBe(true);
    expect(ctx.now()).toBe(fixed);
    expect(ctx.secrets).toEqual(['x']);
  });
});
