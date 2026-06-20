import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@unpolarize/code-sessions-schema': fileURLToPath(
        new URL('./packages/schema/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['packages/**/*.test.ts'],
    environment: 'node',
    globals: false,
    pool: 'forks',
  },
});
