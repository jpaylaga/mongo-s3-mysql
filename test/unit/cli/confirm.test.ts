import { afterEach, describe, expect, it } from 'vitest';
import confirm from '../../../src/cli/confirm.js';

const original = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');

afterEach(() => {
  if (original) Object.defineProperty(process.stdin, 'isTTY', original);
  else delete (process.stdin as { isTTY?: boolean }).isTTY;
});

describe('confirm', () => {
  it('returns at once when skipped', async () => {
    await expect(confirm('Go?', true)).resolves.toBeUndefined();
  });

  it('refuses to prompt without a TTY', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    await expect(confirm('Go?')).rejects.toThrow('not a TTY: pass --yes to confirm');
  });
});
