import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Unit tests only: no network, no Docker. The e2e suite has its own config.
export default defineConfig({
  resolve: {
    // Source imports use the '#' aliases of package.json "imports"; Vite does not read the
    // "source" condition, so point them at src/ here.
    alias: [{ find: /^#(.*)$/, replacement: fileURLToPath(new URL('./src/$1', import.meta.url)) }],
  },
  test: {
    include: ['test/unit/**/*.test.ts'],
    testTimeout: 20_000,
  },
});
