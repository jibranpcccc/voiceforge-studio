import { createHash } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const defaultManifestPath = join(rootDir, 'public', 'model-manifests', 'models.json');

// Optional q4 language model override for Chatterbox hardware without WebGPU shader-f16.
// Mirrors getChatterboxManifestEntry('q4') in src/engines/chatterbox/ChatterboxEngine.ts.
const CHATTERBOX_Q4_LM_ARTIFACTS = [
  {
    role: 'language_model',
    relativePath: 'onnx/language_model_q4.onnx',
    url: 'https://huggingface.co/onnx-community/chatterbox-ONNX/resolve/3cab09af388d3f02bba43443fce88c1f4525ac43/onnx/language_model_q4.onnx',
    sizeBytes: 227911,
    sha256: '7f8cdca83b2493536cbf3acf421199808a3d68736f55f4eabd20ef8a99da4313',
    format: 'onnx',
    required: true,
  },
  {
    role: 'language_model_data',
    relativePath: 'onnx/language_model_q4.onnx_data',
    url: 'https://huggingface.co/onnx-community/chatterbox-ONNX/resolve/3cab09af388d3f02bba43443fce88c1f4525ac43/onnx/language_model_q4.onnx_data',
    sizeBytes: 353621248,
    sha256: '5203d1e83c159316f9923c5c83759f6a34f87be1322ce4ad0facd9fc4aef4790',
    format: 'onnx_data',
    required: true,
  },
];

function printHelp() {
  console.log(`VoiceForge Studio — Self-Hosted Model Downloader

Downloads commit-pinned ONNX model artifacts from public/model-manifests/models.json,
verifies exact byte sizes and SHA-256 checksums, and writes a ready-to-upload directory
for self-hosting alongside cPanel / static deployments.

Usage:
  node scripts/download-models.mjs [options]

Options:
  --engine <id>       Engine to download: pocket-tts | chatterbox | all (default: pocket-tts)
  --out <dir>         Output directory (default: models)
  --precision <mode>  Chatterbox LM precision: q4f16 | q4 | both (default: q4f16)
  --layout <mode>     Directory layout:
                        flat       -> <out>/<relativePath> (matches modelBaseUrl "./models/")
                        by-engine  -> <out>/<engineId>/<relativePath> (matches "./models/{engineId}/")
                      (default: flat)
  --manifest <path>   Path to manifest JSON (default: public/model-manifests/models.json)
  --force             Re-download and overwrite existing verified files
  --dry-run           Validate manifest and print download plan without downloading
  -h, --help          Show this help text

Examples:
  node scripts/download-models.mjs --engine pocket-tts --out models
  node scripts/download-models.mjs --engine all --out dist-cpanel/models
  node scripts/download-models.mjs --engine chatterbox --precision both --out models
`);
}

function parseArgs(argv) {
  const opts = {
    engine: 'pocket-tts',
    out: 'models',
    precision: 'q4f16',
    layout: 'flat',
    manifest: defaultManifestPath,
    force: false,
    dryRun: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      opts.help = true;
    } else if (arg === '--force') {
      opts.force = true;
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg === '--engine' && i + 1 < argv.length) {
      opts.engine = argv[++i];
    } else if (arg.startsWith('--engine=')) {
      opts.engine = arg.slice('--engine='.length);
    } else if (arg === '--out' && i + 1 < argv.length) {
      opts.out = argv[++i];
    } else if (arg.startsWith('--out=')) {
      opts.out = arg.slice('--out='.length);
    } else if (arg === '--precision' && i + 1 < argv.length) {
      opts.precision = argv[++i];
    } else if (arg.startsWith('--precision=')) {
      opts.precision = arg.slice('--precision='.length);
    } else if (arg === '--layout' && i + 1 < argv.length) {
      opts.layout = argv[++i];
    } else if (arg.startsWith('--layout=')) {
      opts.layout = arg.slice('--layout='.length);
    } else if (arg === '--manifest' && i + 1 < argv.length) {
      opts.manifest = resolve(argv[++i]);
    } else if (arg.startsWith('--manifest=')) {
      opts.manifest = resolve(arg.slice('--manifest='.length));
    } else {
      throw new Error(`Unknown or incomplete option: ${arg}`);
    }
  }

  if (!['pocket-tts', 'chatterbox', 'all'].includes(opts.engine)) {
    throw new Error(`Invalid --engine '${opts.engine}'. Expected pocket-tts, chatterbox, or all.`);
  }
  if (!['q4f16', 'q4', 'both'].includes(opts.precision)) {
    throw new Error(`Invalid --precision '${opts.precision}'. Expected q4f16, q4, or both.`);
  }
  if (!['flat', 'by-engine'].includes(opts.layout)) {
    throw new Error(`Invalid --layout '${opts.layout}'. Expected flat or by-engine.`);
  }

  return opts;
}

function loadManifest(manifestPath) {
  if (!existsSync(manifestPath)) {
    throw new Error(`Manifest not found at ${manifestPath}`);
  }
  const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!parsed || !Array.isArray(parsed.models)) {
    throw new Error(`Invalid manifest structure in ${manifestPath}`);
  }
  return parsed;
}

function selectArtifactsForRun(manifest, opts) {
  const entries =
    opts.engine === 'all'
      ? manifest.models
      : manifest.models.filter((m) => m.engineId === opts.engine);

  if (entries.length === 0) {
    throw new Error(`Engine '${opts.engine}' not found in manifest.`);
  }

  const jobs = [];
  for (const entry of entries) {
    let artifacts = entry.artifacts.filter((a) => a.required !== false);

    if (entry.engineId === 'chatterbox') {
      if (opts.precision === 'q4') {
        artifacts = [
          ...artifacts.filter(
            (a) => a.role !== 'language_model' && a.role !== 'language_model_data'
          ),
          ...CHATTERBOX_Q4_LM_ARTIFACTS,
        ];
      } else if (opts.precision === 'both') {
        artifacts = [...artifacts, ...CHATTERBOX_Q4_LM_ARTIFACTS];
      }
    }

    for (const artifact of artifacts) {
      jobs.push({
        engineId: entry.engineId,
        revision: entry.revision,
        artifact,
      });
    }
  }

  return jobs;
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${bytes} B`;
}

async function computeFileSha256(filePath) {
  const hash = createHash('sha256');
  const { createReadStream } = await import('node:fs');
  await new Promise((resolvePromise, rejectPromise) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', resolvePromise);
    stream.on('error', rejectPromise);
  });
  return hash.digest('hex');
}

async function isAlreadyVerified(targetPath, expectedSize, expectedSha256) {
  if (!existsSync(targetPath)) return false;
  const stats = statSync(targetPath);
  if (!stats.isFile() || stats.size !== expectedSize) {
    return false;
  }
  const actualSha = await computeFileSha256(targetPath);
  return actualSha === expectedSha256;
}

async function downloadAndVerify(job, outDir, layout, force) {
  const { engineId, artifact } = job;
  const targetPath =
    layout === 'by-engine'
      ? join(outDir, engineId, ...artifact.relativePath.split('/'))
      : join(outDir, ...artifact.relativePath.split('/'));

  mkdirSync(dirname(targetPath), { recursive: true });

  if (!force && (await isAlreadyVerified(targetPath, artifact.sizeBytes, artifact.sha256))) {
    console.log(`[skip] ${artifact.relativePath} (${formatBytes(artifact.sizeBytes)}, SHA-256 verified)`);
    return { status: 'skipped', targetPath };
  }

  const tempPath = `${targetPath}.tmp`;
  rmSync(tempPath, { force: true });

  const response = await fetch(artifact.url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`HTTP ${response.status} ${response.statusText} fetching ${artifact.url}`);
  }

  const hash = createHash('sha256');
  const fileStream = createWriteStream(tempPath);
  let downloadedBytes = 0;
  let lastLoggedPct = -10;

  try {
    for await (const chunk of response.body) {
      const buf = Buffer.from(chunk);
      downloadedBytes += buf.byteLength;
      hash.update(buf);
      if (!fileStream.write(buf)) {
        await new Promise((res) => fileStream.once('drain', res));
      }
      if (artifact.sizeBytes > 0) {
        const pct = Math.floor((downloadedBytes / artifact.sizeBytes) * 100);
        if (pct >= lastLoggedPct + 10 || downloadedBytes === artifact.sizeBytes) {
          lastLoggedPct = pct;
          process.stdout.write(
            `\r[get ] ${artifact.relativePath} — ${pct}% (${formatBytes(downloadedBytes)} / ${formatBytes(artifact.sizeBytes)})`
          );
        }
      }
    }

    await new Promise((res, rej) => {
      fileStream.end((err) => (err ? rej(err) : res()));
    });
    process.stdout.write('\n');

    if (downloadedBytes !== artifact.sizeBytes) {
      throw new Error(
        `Size mismatch for ${artifact.relativePath}: expected ${artifact.sizeBytes} B, got ${downloadedBytes} B`
      );
    }

    const actualSha = hash.digest('hex');
    if (actualSha !== artifact.sha256) {
      throw new Error(
        `SHA-256 mismatch for ${artifact.relativePath}: expected ${artifact.sha256}, got ${actualSha}`
      );
    }

    renameSync(tempPath, targetPath);
    console.log(`[ok  ] ${artifact.relativePath} -> ${targetPath}`);
    return { status: 'downloaded', targetPath };
  } catch (err) {
    fileStream.destroy();
    rmSync(tempPath, { force: true });
    throw err;
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  const manifest = loadManifest(opts.manifest);
  const jobs = selectArtifactsForRun(manifest, opts);
  const totalBytes = jobs.reduce((sum, j) => sum + j.artifact.sizeBytes, 0);
  const outDir = resolve(opts.out);

  console.log(
    `[download-models] Engine=${opts.engine}, Precision=${opts.precision}, Layout=${opts.layout}, Artifacts=${jobs.length}, Total=${formatBytes(totalBytes)}`
  );
  console.log(`[download-models] Target directory: ${outDir}`);

  if (opts.dryRun) {
    for (const job of jobs) {
      const relOut =
        opts.layout === 'by-engine'
          ? `${job.engineId}/${job.artifact.relativePath}`
          : job.artifact.relativePath;
      console.log(
        `  - [${job.engineId}] ${relOut} (${job.artifact.sizeBytes} B, sha256=${job.artifact.sha256.slice(0, 12)}...)`
      );
    }
    return;
  }

  mkdirSync(outDir, { recursive: true });
  let downloaded = 0;
  let skipped = 0;
  for (const job of jobs) {
    const result = await downloadAndVerify(job, outDir, opts.layout, opts.force);
    if (result.status === 'downloaded') downloaded += 1;
    else skipped += 1;
  }

  const suggestedUrl = opts.layout === 'by-engine' ? './models/{engineId}/' : './models/';
  console.log(
    `[download-models] Complete: ${downloaded} downloaded, ${skipped} verified/skipped. Upload '${opts.out}/' alongside your static files and set Self-Hosted Model Base URL to '${suggestedUrl}' in Settings.`
  );
}

main().catch((err) => {
  console.error(`[download-models] Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
