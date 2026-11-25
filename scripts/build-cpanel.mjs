import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, zipSync } from 'fflate';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const distCpanelDir = join(rootDir, 'dist-cpanel');
const releaseDir = join(rootDir, 'release');
const releaseZipPath = join(releaseDir, 'voiceforge-studio-cpanel.zip');
const htaccessSource = join(rootDir, 'scripts', 'cpanel.htaccess');

function runNodeScript(scriptPath, envOverrides = {}) {
  execFileSync(process.execPath, [scriptPath], {
    cwd: rootDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      ...envOverrides,
    },
  });
}

function collectFilesRecursive(dir, basePrefix = '') {
  const entries = {};
  const names = readdirSync(dir).sort();
  for (const name of names) {
    const fullPath = join(dir, name);
    const relPath = basePrefix ? posix.join(basePrefix, name) : name;
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      Object.assign(entries, collectFilesRecursive(fullPath, relPath));
    } else if (stats.isFile()) {
      entries[relPath] = new Uint8Array(readFileSync(fullPath));
    }
  }
  return entries;
}

function formatMiB(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function main() {
  if (!existsSync(htaccessSource)) {
    throw new Error(`Missing Apache config template: ${htaccessSource}`);
  }

  console.log('[build-cpanel] Preparing ONNX Runtime Web assets...');
  runNodeScript(join(rootDir, 'scripts', 'copy-ort-runtime.mjs'));

  console.log('[build-cpanel] Running TypeScript typecheck...');
  const tscBin = join(rootDir, 'node_modules', 'typescript', 'bin', 'tsc');
  execFileSync(process.execPath, [tscBin, '--noEmit'], {
    cwd: rootDir,
    stdio: 'inherit',
  });

  console.log('[build-cpanel] Building static bundle with VITE_BASE_PATH=./ into dist-cpanel/...');
  rmSync(distCpanelDir, { recursive: true, force: true });
  const viteBin = join(rootDir, 'node_modules', 'vite', 'bin', 'vite.js');
  execFileSync(process.execPath, [viteBin, 'build', '--outDir', 'dist-cpanel', '--emptyOutDir'], {
    cwd: rootDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      VITE_BASE_PATH: './',
    },
  });

  console.log('[build-cpanel] Copying scripts/cpanel.htaccess -> dist-cpanel/.htaccess...');
  copyFileSync(htaccessSource, join(distCpanelDir, '.htaccess'));

  // Remove placeholder .gitkeep files from distributable package if present
  for (const relGitkeep of ['icons/.gitkeep', 'model-manifests/.gitkeep', 'runtime/.gitkeep']) {
    const candidate = join(distCpanelDir, relGitkeep);
    if (existsSync(candidate)) {
      rmSync(candidate, { force: true });
    }
  }

  console.log('[build-cpanel] Archiving dist-cpanel/ -> release/voiceforge-studio-cpanel.zip...');
  mkdirSync(releaseDir, { recursive: true });
  const archiveInputs = collectFilesRecursive(distCpanelDir);
  const zipped = zipSync(archiveInputs, { level: 6 });
  writeFileSync(releaseZipPath, zipped);

  // Verify zip contents by round-tripping through unzipSync
  const archiveBytes = new Uint8Array(readFileSync(releaseZipPath));
  const extractedEntries = unzipSync(archiveBytes);
  const extractedNames = Object.keys(extractedEntries);

  const requiredExact = [
    'index.html',
    '.htaccess',
    'sw.js',
    'manifest.webmanifest',
    'model-manifests/models.json',
  ];
  for (const req of requiredExact) {
    if (!extractedNames.includes(req)) {
      throw new Error(`Archive verification failed: missing ${req}`);
    }
  }

  const hasRuntimeWasm = extractedNames.some((n) => n.startsWith('runtime/ort-wasm') && n.endsWith('.wasm'));
  const hasRuntimeMjs = extractedNames.some((n) => n.startsWith('runtime/ort-wasm') && n.endsWith('.mjs'));
  const hasAssets = extractedNames.some((n) => n.startsWith('assets/'));
  if (!hasRuntimeWasm || !hasRuntimeMjs || !hasAssets) {
    throw new Error(
      `Archive verification failed: runtimeWasm=${hasRuntimeWasm}, runtimeMjs=${hasRuntimeMjs}, assets=${hasAssets}`
    );
  }

  console.log(
    `[build-cpanel] Verified ${releaseZipPath} (${extractedNames.length} files, ${formatMiB(archiveBytes.byteLength)}).`
  );
}

main();
