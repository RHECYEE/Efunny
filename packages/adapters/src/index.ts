/**
 * @arbterminal/adapters — venue integrations, for Node.
 *
 * Everything in `browser.ts`, plus the filesystem-backed CSV directory
 * adapter. A WebView build must import `browser.js` instead; see the note
 * there.
 */

export * from './browser.js';

// Filesystem-backed variant. Node only — the mobile build must not import it.
export * from './manual/node.js';
