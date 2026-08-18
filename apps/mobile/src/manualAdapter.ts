/**
 * Re-export of the manual venue adapter, imported by module path.
 *
 * The adapters package index also exports the filesystem-backed directory
 * variant, and `node:fs` cannot be bundled into a WebView. Reaching for the
 * specific module keeps that import out of the mobile bundle entirely rather
 * than relying on tree-shaking to drop it.
 */
export {
  ManualCsvAdapter,
  type ImportDiagnostics,
  type ManualCsvAdapterOptions,
} from '../../../packages/adapters/src/manual/adapter.js';
