import { describe, expect, it } from 'vitest';
import createProgram from '#cli/createProgram';
import defaultConfigPath from '#cli/defaultConfigPath';

describe('defaultConfigPath', () => {
  it('is the default of the -c flag', () => {
    expect(defaultConfigPath).toBe('mongo-s3-mysql.config.json');
    expect(createProgram().helpInformation()).toContain(`(default: "${defaultConfigPath}")`);
  });
});
