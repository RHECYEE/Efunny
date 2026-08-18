import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@arbterminal/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)),
      // Import the adapter entry points directly rather than the package
      // index: the index re-exports the filesystem-backed directory adapter,
      // and `node:fs` cannot be bundled for a WebView.
      '@arbterminal/adapters': fileURLToPath(
        new URL('../../packages/adapters/src/index.ts', import.meta.url),
      ),
    },
  },
  build: { target: 'es2022' },
});
