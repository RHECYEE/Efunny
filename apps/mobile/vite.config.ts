import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@arbterminal/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)),
      // The browser entry point, not the package index: the index also
      // re-exports the filesystem-backed directory adapter, and `node:fs`
      // cannot be bundled for a WebView.
      '@arbterminal/adapters/browser': fileURLToPath(
        new URL('../../packages/adapters/src/browser.ts', import.meta.url),
      ),
    },
  },
  build: { target: 'es2022' },
});
