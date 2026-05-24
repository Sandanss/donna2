#!/usr/bin/env node

import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import {
  POST_CALL_JOB_STATUSES,
  POST_CALL_PROVIDER_KEYS,
  PostCallProviderSemaphores,
  createPostCallWorkflowHandlers,
  runPostCallWorkerOnce,
} from '../services/post-call-jobs.js';

function parseArgs(argv) {
  const args = {
    limit: 25,
    leaseSeconds: 120,
    workerId: `post-call-shadow-${process.pid}`,
    jobTypes: [],
    providerLimits: {},
    confirmDbWrites: false,
    handlerMode: process.env.POST_CALL_WORKER_HANDLER_MODE || 'artifact_verification',
  };

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--confirm-db-writes') args.confirmDbWrites = true;
    else if (arg.startsWith('--limit=')) args.limit = Number.parseInt(arg.slice('--limit='.length), 10);
    else if (arg.startsWith('--lease-seconds=')) args.leaseSeconds = Number.parseInt(arg.slice('--lease-seconds='.length), 10);
    else if (arg.startsWith('--worker-id=')) args.workerId = arg.slice('--worker-id='.length);
    else if (arg.startsWith('--job-types=')) {
      args.jobTypes = arg.slice('--job-types='.length).split(',').map((value) => value.trim()).filter(Boolean);
    } else if (arg.startsWith('--handler-mode=')) {
      args.handlerMode = arg.slice('--handler-mode='.length);
    } else if (arg.startsWith('--db-concurrency=')) {
      args.providerLimits[POST_CALL_PROVIDER_KEYS.DB] = Number.parseInt(arg.slice('--db-concurrency='.length), 10);
    } else if (arg.startsWith('--gemini-flash-concurrency=')) {
      args.providerLimits[POST_CALL_PROVIDER_KEYS.GEMINI_FLASH] = Number.parseInt(arg.slice('--gemini-flash-concurrency='.length), 10);
    } else if (arg.startsWith('--openai-embeddings-concurrency=')) {
      args.providerLimits[POST_CALL_PROVIDER_KEYS.OPENAI_EMBEDDINGS] = Number.parseInt(arg.slice('--openai-embeddings-concurrency='.length), 10);
    } else if (arg.startsWith('--resend-concurrency=')) {
      args.providerLimits[POST_CALL_PROVIDER_KEYS.RESEND] = Number.parseInt(arg.slice('--resend-concurrency='.length), 10);
    }
  }

  return args;
}

function usage() {
  return [
    'Usage:',
    '  npm run phase6:post-call-worker-once -- --confirm-db-writes',
    '  npm run phase6:post-call-worker-once -- --confirm-db-writes --limit=100 --job-types=metrics_finalize,reminder_recovery',
    '',
    'Runs one PHI-free post-call workflow tick. Default handler mode verifies production artifacts without printing PHI.',
    'This command leases and updates post_call_jobs rows, so --confirm-db-writes is required.',
  ].join('\n');
}

function summarize(results) {
  const byStatus = {};
  const byJobType = {};
  for (const item of results || []) {
    byStatus[item.status] = (byStatus[item.status] || 0) + 1;
    const key = `${item.jobType}:${item.status}`;
    byJobType[key] = (byJobType[key] || 0) + 1;
  }
  return { byStatus, byJobType };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    process.exit(0);
  }
  if (!args.confirmDbWrites) {
    console.error(JSON.stringify({
      ok: false,
      error: '--confirm-db-writes is required because this command mutates post_call_jobs rows',
      phiPolicy: { outputContainsRawPhi: false },
    }, null, 2));
    process.exit(2);
  }
  if (!process.env.DATABASE_URL) {
    console.error(JSON.stringify({
      ok: false,
      error: 'DATABASE_URL is required',
      phiPolicy: { outputContainsRawPhi: false },
    }, null, 2));
    process.exit(2);
  }

  const result = await runPostCallWorkerOnce({
    workerId: args.workerId,
    handlers: createPostCallWorkflowHandlers({ mode: args.handlerMode }),
    providerSemaphores: new PostCallProviderSemaphores(args.providerLimits),
    jobTypes: args.jobTypes,
    limit: args.limit,
    leaseSeconds: args.leaseSeconds,
  });
  const summary = summarize(result.results);
  const deadLettered = Number(result.counts?.[POST_CALL_JOB_STATUSES.DEAD_LETTER] || 0);
  const ok = deadLettered === 0 && Number(result.blockedDeadLettered || 0) === 0;

  console.log(JSON.stringify({
    ok,
    handlerMode: args.handlerMode,
    workerId: args.workerId,
    leased: result.leased,
    blockedDeadLettered: result.blockedDeadLettered,
    counts: result.counts,
    ...summary,
    providerSemaphores: result.providerSemaphores,
    phiPolicy: {
      outputContainsRawPhi: false,
      notes: 'Aggregate job status counts only. No names, phone numbers, transcripts, summaries, reminder text, notes, prompts, payload bodies, or job IDs are printed.',
    },
  }, null, 2));
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      error: String(error?.code || error?.message || error || 'unknown_error').slice(0, 160),
      phiPolicy: { outputContainsRawPhi: false },
    }, null, 2));
    process.exit(1);
  });
}
