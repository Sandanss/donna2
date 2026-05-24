#!/usr/bin/env node

import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {
  POST_CALL_PROVIDER_KEYS,
  resolvePostCallProviderCaps,
  resolvePostCallProviderLimits,
  runPostCallStampedeSimulation,
} from '../services/post-call-jobs.js';

function parseArgs(argv) {
  const args = {
    completions: 600,
    out: null,
    dbPoolIdleRatio: 0.2,
    providerOverrides: {},
    providerMeasurements: {},
  };

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg.startsWith('--completions=')) args.completions = Number.parseInt(arg.slice('--completions='.length), 10);
    else if (arg.startsWith('--out=')) args.out = arg.slice('--out='.length);
    else if (arg.startsWith('--db-pool-idle-ratio=')) {
      args.dbPoolIdleRatio = Number.parseFloat(arg.slice('--db-pool-idle-ratio='.length));
    } else if (arg.startsWith('--gemini-flash-concurrency=')) {
      args.providerOverrides[POST_CALL_PROVIDER_KEYS.GEMINI_FLASH] =
        Number.parseInt(arg.slice('--gemini-flash-concurrency='.length), 10);
    } else if (arg.startsWith('--openai-embeddings-concurrency=')) {
      args.providerOverrides[POST_CALL_PROVIDER_KEYS.OPENAI_EMBEDDINGS] =
        Number.parseInt(arg.slice('--openai-embeddings-concurrency='.length), 10);
    } else if (arg.startsWith('--resend-concurrency=')) {
      args.providerOverrides[POST_CALL_PROVIDER_KEYS.RESEND] =
        Number.parseInt(arg.slice('--resend-concurrency='.length), 10);
    } else if (arg.startsWith('--db-concurrency=')) {
      args.providerOverrides[POST_CALL_PROVIDER_KEYS.DB] =
        Number.parseInt(arg.slice('--db-concurrency='.length), 10);
    } else if (arg.startsWith('--anthropic-haiku-peak-tpm=')) {
      args.providerMeasurements.anthropicHaikuPeakTpm =
        Number.parseInt(arg.slice('--anthropic-haiku-peak-tpm='.length), 10);
    } else if (arg.startsWith('--gemini-flash-measured-concurrent=')) {
      args.providerMeasurements.geminiFlashConcurrent =
        Number.parseInt(arg.slice('--gemini-flash-measured-concurrent='.length), 10);
    } else if (arg.startsWith('--openai-embeddings-rpm=')) {
      args.providerMeasurements.openAiEmbeddingsRpm =
        Number.parseInt(arg.slice('--openai-embeddings-rpm='.length), 10);
    } else if (arg.startsWith('--resend-send-rate=')) {
      args.providerMeasurements.resendSendRate =
        Number.parseInt(arg.slice('--resend-send-rate='.length), 10);
    }
  }

  return args;
}

function usage() {
  return [
    'Usage:',
    '  npm run phase6:post-call-stampede',
    '  npm run phase6:post-call-stampede -- --completions=600 --gemini-flash-concurrency=24 --openai-embeddings-concurrency=25 --resend-concurrency=10',
    '',
    'Output is PHI-free aggregate timing and concurrency data only.',
  ].join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    process.exit(0);
  }

  const providerCaps = resolvePostCallProviderCaps(args.providerMeasurements);
  const providerLimits = resolvePostCallProviderLimits({
    providerCaps,
    overrides: args.providerOverrides,
  });
  const idleRatio = Number.isFinite(args.dbPoolIdleRatio) ? args.dbPoolIdleRatio : 0;
  const report = await runPostCallStampedeSimulation({
    completions: args.completions,
    providerLimits,
    dbPoolStatsProvider: async () => ({
      idle: Math.round(idleRatio * 1000),
      max: 1000,
    }),
  });
  const json = JSON.stringify({
    ...report,
    phiPolicy: {
      outputContainsRawPhi: false,
      notes: 'Provider-stub simulation only; no senior IDs, phone numbers, transcripts, summaries, reminder text, notes, prompts, or payload bodies.',
    },
  }, null, 2);

  if (args.out) {
    await fs.writeFile(args.out, `${json}\n`);
  }
  console.log(json);
  process.exit(report.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(JSON.stringify({
      ok: false,
      error: String(error?.message || error || 'unknown_error').slice(0, 240),
      phiPolicy: { outputContainsRawPhi: false },
    }, null, 2));
    process.exit(1);
  });
}
