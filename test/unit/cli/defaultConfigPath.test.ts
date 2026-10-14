import { describe, expect, it } from 'vitest';
import createProgram from '../../../src/cli/createProgram.js';
import defaultConfigPath from '../../../src/cli/defaultConfigPath.js';

describe('defaultConfigPath', () => {
  it('is the default of the -c flag', () => {
    expect(defaultConfigPath).toBe('mongo-s3-mysql.config.json');
    expect(createProgram().helpInformation()).toContain(`(default: "${defaultConfigPath}")`);
  });
});
