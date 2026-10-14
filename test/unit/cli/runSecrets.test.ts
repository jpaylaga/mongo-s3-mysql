import { afterEach, describe, expect, it } from 'vitest';
import runSecrets from '#cli/runSecrets';

describe('runSecrets', () => {
  afterEach(() => runSecrets.clear());

  it('remembers recorded values once each, drops empty strings and forgets them on clear', () => {
    expect(runSecrets.list()).toEqual([]);
    runSecrets.record(['one', '', 'two']);
    runSecrets.record(['two', 'three']);
    expect(runSecrets.list().sort()).toEqual(['one', 'three', 'two']);
    runSecrets.clear();
    expect(runSecrets.list()).toEqual([]);
  });
});
