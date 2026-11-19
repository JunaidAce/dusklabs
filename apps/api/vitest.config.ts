import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@dusklabs/shared': path.resolve(__dirname, '../../packages/shared/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    globals: false,
    fileParallelism: false,
    // Integration suites perform real Argon2id (64 MiB) hashing per auth call on SQLite;
    // the 5s unit-test default is too small on typical dev hardware.
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
