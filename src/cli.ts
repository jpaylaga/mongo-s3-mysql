#!/usr/bin/env node
import createProgram from '#cli/createProgram';
import fatalMessage from '#cli/fatalMessage';

createProgram()
  .parseAsync()
  .catch((err: unknown) => {
    process.stderr.write(`${fatalMessage(err)}\n`);
    process.exit(1);
  });
