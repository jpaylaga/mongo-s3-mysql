import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Testcontainers stacks are slow to start and share Docker, so files run one at a time.
export default defineConfig({
  resolve: {
    alias: [{ find: /^#(.*)$/, replacement: fileURLToPath(new URL('./src/$1', import.meta.url)) }],
  },
  test: {
    include: ['test/e2e/**/*.test.ts'],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    fileParallelism: false,
  },
});
