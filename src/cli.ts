#!/usr/bin/env node
import createProgram from './cli/createProgram.js';
import fatalMessage from './cli/fatalMessage.js';

createProgram().parseAsync().catch((err: unknown) => {
  process.stderr.write(`${fatalMessage(err)}\n`);
  process.exit(1);
});
