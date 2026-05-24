#!/usr/bin/env node

import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import {
  initiateTelnyxOutboundCall,
  prewarmTelnyxOutboundContext,
} from '../services/telnyx.js';

function parseArgs(argv) {
  const args = {
    seniorId: null,
    callType: 'check-in',
    prewarm: true,
    prewarmOnly: false,
    confirmLiveCall: false,
    serviceLabel: 'node',
    baseUrl: null,
  };

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--no-prewarm') args.prewarm = false;
    else if (arg === '--prewarm-only') args.prewarmOnly = true;
    else if (arg === '--confirm-live-call') args.confirmLiveCall = true;
    else if (arg.startsWith('--senior-id=')) args.seniorId = arg.slice('--senior-id='.length);
    else if (arg.startsWith('--call-type=')) args.callType = arg.slice('--call-type='.length);
    else if (arg.startsWith('--service-label=')) args.serviceLabel = arg.slice('--service-label='.length);
    else if (arg.startsWith('--base-url=')) args.baseUrl = arg.slice('--base-url='.length);
  }

  return args;
}

function usage() {
  return [
    'Usage:',
    '  npm run phase0:live-call-drill -- --senior-id=<uuid> --prewarm-only',
    '  npm run phase0:live-call-drill -- --senior-id=<uuid> --confirm-live-call',
    '',
    'Safety:',
    '  --confirm-live-call is required before this script places an outbound Telnyx call.',
    '  The script accepts a senior ID only. It never accepts or prints phone numbers, names, notes, or reminder text.',
  ].join('\n');
}

function fail(message, code = 1) {
  console.error(JSON.stringify({
    ok: false,
    error: message,
    phiPolicy: {
      outputContainsRawPhi: false,
    },
  }, null, 2));
  process.exit(code);
}

export async function runLiveTelnyxDrill({
  seniorId,
  callType = 'check-in',
  prewarm = true,
  prewarmOnly = false,
  confirmLiveCall = false,
  serviceLabel = 'node',
  baseUrl = null,
} = {}) {
  if (!seniorId) {
    throw new Error('seniorId is required');
  }
  if (!prewarmOnly && !confirmLiveCall) {
    throw new Error('--confirm-live-call is required before placing an outbound call');
  }

  const result = {
    ok: true,
    seniorId,
    callType,
    prewarmAttempted: false,
    prewarmOk: null,
    callAttempted: false,
    callAccepted: null,
    callSid: null,
    callControlId: null,
    checkedAt: new Date().toISOString(),
    phiPolicy: {
      outputContainsRawPhi: false,
      notes: 'No phone numbers, names, transcripts, notes, reminder text, or prompt context are printed.',
    },
  };

  let prewarmedContext = null;
  if (prewarm) {
    result.prewarmAttempted = true;
    prewarmedContext = await prewarmTelnyxOutboundContext({
      seniorId,
      callType,
      baseUrl,
    });
    result.prewarmOk = Boolean(prewarmedContext?.seniorId || prewarmedContext?.senior_id);
    result.prewarmSource = prewarmedContext?.contextSeedSource || prewarmedContext?.context_seed_source || null;
  }

  if (prewarmOnly) {
    return result;
  }

  result.callAttempted = true;
  const call = await initiateTelnyxOutboundCall({
    seniorId,
    callType,
    prewarmedContext,
    serviceLabel,
    baseUrl,
  });

  result.callAccepted = Boolean(call?.callSid || call?.callControlId);
  result.callSid = call?.callSid || null;
  result.callControlId = call?.callControlId || null;
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    process.exit(0);
  }

  if (!process.env.DONNA_API_KEYS && !process.env.DONNA_API_KEY) {
    fail('DONNA_API_KEYS or DONNA_API_KEY is required', 2);
  }

  try {
    const result = await runLiveTelnyxDrill(args);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  } catch (error) {
    fail(String(error?.message || error || 'unknown_error').slice(0, 240));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
