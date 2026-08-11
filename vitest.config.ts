import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const resolvePath = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // Workspace packages ship TypeScript sources, so point the test runner
      // at them directly rather than at an unbuilt `main` field.
      '@arbterminal/core': resolvePath('./packages/core/src/index.ts'),
      '@arbterminal/adapters': resolvePath('./packages/adapters/src/index.ts'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    environment: 'node',
  },
});
