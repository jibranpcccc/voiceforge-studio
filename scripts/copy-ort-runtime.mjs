import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const ortDistDir = join(rootDir, 'node_modules', 'onnxruntime-web', 'dist');
const targetDir = join(rootDir, 'public', 'runtime');

if (!existsSync(ortDistDir)) {
  console.warn('[copy-ort-runtime] onnxruntime-web/dist not found yet; skipping.');
  process.exit(0);
}

mkdirSync(targetDir, { recursive: true });

// Clean previously copied runtime artifacts while preserving .gitkeep
for (const entry of readdirSync(targetDir)) {
  if (entry === '.gitkeep') continue;
  rmSync(join(targetDir, entry), { recursive: true, force: true });
}

const runtimeFiles = readdirSync(ortDistDir).filter(
  (file) =>
    file.startsWith('ort-wasm') &&
    (file.endsWith('.wasm') || file.endsWith('.mjs') || file.endsWith('.js'))
);

for (const file of runtimeFiles) {
  cpSync(join(ortDistDir, file), join(targetDir, file));
}

console.log(
  `[copy-ort-runtime] Copied ${runtimeFiles.length} ONNX Runtime Web assets to public/runtime/.`
);
