import { defineConfig } from 'vitest/config';

// Unit tests only: no network, no Docker. The e2e suite has its own config.
export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
    testTimeout: 20_000,
  },
});
