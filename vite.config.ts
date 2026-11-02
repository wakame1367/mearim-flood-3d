/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/realdata/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60000,
  },
});
