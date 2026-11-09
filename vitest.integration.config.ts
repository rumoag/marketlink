import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Pruebas de integracion contra un Postgres real (TEST_DATABASE_URL). Se omiten si no esta definida.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      '@tests': path.resolve(import.meta.dirname, 'tests'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
