#!/usr/bin/env node
/**
 * Package ArbTerminal as a single executable.
 *
 *   npm run package
 *
 * Pipeline:
 *   1. Build the UI with Vite.
 *   2. Bundle the server into one CommonJS file with esbuild.
 *   3. Write a SEA config listing every UI file as an embedded asset.
 *   4. Generate the SEA blob and inject it into a copy of the Node binary.
 *
 * The result is one file that carries the Node runtime, the server, and the
 * whole interface. It boots, opens a browser, and needs nothing installed.
 *
 * Cross-building is not supported: the binary is a copy of *this* machine's
 * Node, so a Windows .exe must be produced on Windows. The release workflow
 * runs this on each platform's own runner.
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, chmodSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = join(root, 'build');
const webDist = join(root, 'apps', 'web', 'dist');

const isWindows = process.platform === 'win32';
const exeName = isWindows ? 'ArbTerminal.exe' : 'arbterminal';
const outputPath = join(buildDir, exeName);

function run(command, args, options = {}) {
  console.log(`  $ ${command} ${args.join(' ')}`);
  execFileSync(command, args, { stdio: 'inherit', cwd: root, shell: isWindows, ...options });
}

function walk(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, base));
    // SEA asset keys are POSIX-style so the same key works on every platform.
    else out.push(relative(base, full).split('\\').join('/'));
  }
  return out;
}

console.log('\n[1/4] Building the interface');
rmSync(buildDir, { recursive: true, force: true });
mkdirSync(buildDir, { recursive: true });
run('npx', ['vite', 'build'], { cwd: join(root, 'apps', 'web') });

console.log('\n[2/4] Bundling the server');
const bundlePath = join(buildDir, 'arbterminal.cjs');
run('npx', [
  'esbuild',
  join('apps', 'server', 'src', 'index.ts'),
  '--bundle',
  '--platform=node',
  '--target=node22',
  '--format=cjs',
  // node:sqlite and node:sea are runtime builtins; esbuild must not try to
  // resolve them from node_modules.
  '--external:node:*',
  `--outfile=${relative(root, bundlePath)}`,
]);

console.log('\n[3/4] Collecting interface assets');
const assetKeys = walk(webDist);
const assets = Object.fromEntries(assetKeys.map((key) => [key, join(webDist, key)]));
console.log(`  ${assetKeys.length} files embedded`);

const seaConfigPath = join(buildDir, 'sea-config.json');
writeFileSync(
  seaConfigPath,
  JSON.stringify(
    {
      main: bundlePath,
      output: join(buildDir, 'sea-prep.blob'),
      disableExperimentalSEAWarning: true,
      // The bundle is already a single file; a snapshot would only add
      // startup constraints for no benefit here.
      useSnapshot: false,
      useCodeCache: true,
      assets,
    },
    null,
    2,
  ),
);

console.log('\n[4/4] Building the executable');
run(process.execPath, ['--experimental-sea-config', seaConfigPath]);

copyFileSync(process.execPath, outputPath);
if (!isWindows) chmodSync(outputPath, 0o755);

const postjectArgs = [
  'postject',
  outputPath,
  'NODE_SEA_BLOB',
  join(buildDir, 'sea-prep.blob'),
  '--sentinel-fuse',
  'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
];
// A macOS binary must be re-signed after its contents change, and Mach-O
// needs the blob in a segment rather than appended.
if (process.platform === 'darwin') postjectArgs.push('--macho-segment-name', 'NODE_SEA');
run('npx', postjectArgs);

if (process.platform === 'darwin') {
  try {
    run('codesign', ['--sign', '-', outputPath]);
  } catch {
    console.log('  ad-hoc signing failed; the binary may not launch on macOS');
  }
}

const sizeMb = (statSync(outputPath).size / 1024 / 1024).toFixed(1);
console.log(`\nBuilt ${outputPath} (${sizeMb} MB)`);
console.log('Run it and it will open ArbTerminal in your browser.\n');
