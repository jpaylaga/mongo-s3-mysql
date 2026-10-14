import { defineConfig } from 'vitest/config';

// Testcontainers stacks are slow to start and share Docker, so files run one at a time.
export default defineConfig({
  test: {
    include: ['test/e2e/**/*.test.ts'],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    fileParallelism: false,
  },
});
