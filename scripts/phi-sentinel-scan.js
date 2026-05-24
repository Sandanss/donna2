#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_SCAN_PATHS = [
  'logs',
  'tmp',
  'test-results',
  'playwright-report',
  'coverage',
  'artifacts',
  'pipecat/logs',
  'pipecat/test-results',
  'apps/admin-v2/test-results',
  'apps/website/test-results',
  'apps/observability/test-results',
  'apps/mobile/test-results',
];

const DEFAULT_SENTINELS = [
  'Donna Phi Sentinel',
  'PHI_SENTINEL_REMINDER_DO_NOT_LOG',
  'PHI_SENTINEL_NOTE_DO_NOT_LOG',
  'PHI_SENTINEL_MEDICAL_DO_NOT_LOG',
  'PHI_SENTINEL_TRANSCRIPT_DO_NOT_LOG',
];

const SKIP_DIRS = new Set([
  '.git',
  '.next',
  '.turbo',
  'node_modules',
  '.venv',
  '__pycache__',
]);

const TEXT_EXTENSIONS = new Set([
  '.csv',
  '.html',
  '.json',
  '.jsonl',
  '.log',
  '.md',
  '.out',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
]);

function parseArgs(argv, env = process.env) {
  const args = {
    paths: DEFAULT_SCAN_PATHS,
    json: false,
    sentinels: [...DEFAULT_SENTINELS],
  };

  if (env.PHI_SENTINEL_PHONE) args.sentinels.push(env.PHI_SENTINEL_PHONE);
  if (env.PHI_SENTINEL_EXTRA) {
    args.sentinels.push(...env.PHI_SENTINEL_EXTRA.split(',').map((value) => value.trim()).filter(Boolean));
  }

  for (const arg of argv) {
    if (arg === '--json') {
      args.json = true;
    } else if (arg.startsWith('--paths=')) {
      args.paths = arg.slice('--paths='.length).split(',').map((value) => value.trim()).filter(Boolean);
    } else if (arg.startsWith('--sentinel=')) {
      args.sentinels.push(arg.slice('--sentinel='.length));
    }
  }

  return args;
}

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function isProbablyTextFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return TEXT_EXTENSIONS.has(ext) || ext === '';
}

async function* walk(targetPath) {
  const stat = await fs.stat(targetPath);
  if (stat.isFile()) {
    yield targetPath;
    return;
  }
  if (!stat.isDirectory()) return;

  const entries = await fs.readdir(targetPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const childPath = path.join(targetPath, entry.name);
    if (entry.isDirectory()) {
      yield* walk(childPath);
    } else if (entry.isFile()) {
      yield childPath;
    }
  }
}

async function scanFile(filePath, sentinels) {
  const stat = await fs.stat(filePath);
  if (stat.size > 10 * 1024 * 1024 || !isProbablyTextFile(filePath)) return [];

  const content = await fs.readFile(filePath, 'utf8');
  const findings = [];
  for (const sentinel of sentinels) {
    if (!sentinel) continue;
    const count = content.split(sentinel).length - 1;
    if (count > 0) {
      findings.push({ file: filePath, sentinel, count });
    }
  }
  return findings;
}

async function scanSentinels({ paths: scanPaths, sentinels }) {
  const findings = [];
  const skipped = [];
  let filesScanned = 0;

  for (const targetPath of scanPaths) {
    if (!await exists(targetPath)) {
      skipped.push(targetPath);
      continue;
    }

    for await (const filePath of walk(targetPath)) {
      filesScanned += 1;
      findings.push(...await scanFile(filePath, sentinels));
    }
  }

  return {
    ok: findings.length === 0,
    generatedAt: new Date().toISOString(),
    filesScanned,
    skipped,
    findings,
  };
}

function printHuman(summary) {
  if (summary.ok) {
    console.log(`PHI sentinel scan clean: ${summary.filesScanned} files scanned (${summary.skipped.length} missing paths skipped)`);
    return;
  }

  console.error(`PHI sentinel scan found ${summary.findings.length} finding(s). Matched content is not printed.`);
  for (const finding of summary.findings) {
    console.error(`${finding.file}: sentinel="${finding.sentinel}" count=${finding.count}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const summary = await scanSentinels(args);

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    printHuman(summary);
  }

  process.exit(summary.ok ? 0 : 1);
}

export { scanSentinels, parseArgs };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      error: String(error?.message || error).slice(0, 240),
    }, null, 2));
    process.exit(1);
  });
}
