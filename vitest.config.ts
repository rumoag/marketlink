import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      '@tests': path.resolve(import.meta.dirname, 'tests'),
    },
  },
  test: {
    environment: 'node',
    // Algunas pruebas miden tiempos (p. ej. el procesado de fotos): pocos hilos evitan falsos fallos por carga.
    maxWorkers: 2,
    setupFiles: ['tests/support/setup.ts'],
    include: ['tests/unit/**/*.test.ts', 'tests/properties/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/modules/*/domain/**/*.ts', 'src/modules/*/application/**/*.ts'],
      thresholds: { lines: 80, statements: 80, functions: 80, branches: 70 },
      reporter: ['text-summary', 'lcov'],
    },
  },
});
