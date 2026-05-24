import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

const DEFAULT_RAILWAY_BIN = 'railway';
const DEFAULT_REGION = 'us-west';
const MAX_RAILWAY_REPLICAS = 50;
const SAFE_CODE_PATTERN = /^[a-z0-9_.:/@-]+$/i;

function integerValue(value, defaultValue = 0, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.max(min, Math.min(max, parsed));
}

function optionalString(value) {
  const stringValue = String(value || '').trim();
  return stringValue || null;
}

function safeCode(value, fieldName) {
  const stringValue = optionalString(value);
  if (!stringValue || !SAFE_CODE_PATTERN.test(stringValue)) {
    throw new Error(`${fieldName} must contain only letters, numbers, _, -, ., :, /, or @`);
  }
  return stringValue;
}

function redactCommandArgs(args) {
  return args.map(arg => {
    if (String(arg).startsWith('--token')) return '--token=[redacted]';
    return arg;
  });
}

function parseRailwayJsonOutput(stdout) {
  const trimmed = String(stdout || '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return {
      raw: trimmed.slice(0, 500),
    };
  }
}

export function resolveRailwayScaleConfig(env = process.env, overrides = {}) {
  return {
    railwayBin: optionalString(overrides.railwayBin) ||
      optionalString(env.PHASE8_RAILWAY_BIN) ||
      DEFAULT_RAILWAY_BIN,
    service: optionalString(overrides.service) ||
      optionalString(env.PHASE8_RAILWAY_SERVICE) ||
      optionalString(env.RAILWAY_PIPECAT_SERVICE) ||
      optionalString(env.RAILWAY_PIPECAT_SERVICE_NAME),
    environment: optionalString(overrides.environment) ||
      optionalString(env.PHASE8_RAILWAY_ENVIRONMENT) ||
      optionalString(env.RAILWAY_ENVIRONMENT_NAME),
    region: optionalString(overrides.region) ||
      optionalString(env.PHASE8_RAILWAY_REGION) ||
      DEFAULT_REGION,
  };
}

export function buildRailwayScaleCommand({
  targetReplicas,
  railwayBin = DEFAULT_RAILWAY_BIN,
  service,
  environment,
  region = DEFAULT_REGION,
} = {}) {
  const safeTarget = integerValue(targetReplicas, -1, { min: 0, max: MAX_RAILWAY_REPLICAS });
  if (safeTarget < 0) {
    throw new Error('targetReplicas must be a non-negative integer');
  }

  const safeBin = safeCode(railwayBin, 'railwayBin');
  const safeRegion = safeCode(region, 'region');
  const args = ['scale', `${safeRegion}=${safeTarget}`];

  if (service) {
    args.push('--service', safeCode(service, 'service'));
  }
  if (environment) {
    args.push('--environment', safeCode(environment, 'environment'));
  }
  args.push('--json');

  return {
    bin: safeBin,
    args,
    display: `${safeBin} ${redactCommandArgs(args).join(' ')}`,
    targetReplicas: safeTarget,
    region: safeRegion,
    service: service ? safeCode(service, 'service') : null,
    environment: environment ? safeCode(environment, 'environment') : null,
  };
}

export async function applyRailwayScale({
  targetReplicas,
  reason = 'unspecified',
  dryRun = true,
  service = null,
  environment = null,
  region = null,
  railwayBin = null,
  env = process.env,
  execFileAsync = execFile,
  timeoutMs = 60_000,
  now = new Date(),
} = {}) {
  const config = resolveRailwayScaleConfig(env, {
    railwayBin,
    service,
    environment,
    region,
  });
  const command = buildRailwayScaleCommand({
    targetReplicas,
    railwayBin: config.railwayBin,
    service: config.service,
    environment: config.environment,
    region: config.region,
  });

  if (dryRun) {
    return {
      ok: true,
      applied: false,
      dryRun: true,
      reason,
      targetReplicas: command.targetReplicas,
      command: {
        bin: command.bin,
        args: redactCommandArgs(command.args),
        display: command.display,
      },
      completedAt: now.toISOString(),
      phiPolicy: {
        outputContainsRawPhi: false,
      },
    };
  }

  if (!command.service || !command.environment) {
    throw new Error('service and environment are required for live Railway scale changes');
  }

  const { stdout, stderr } = await execFileAsync(command.bin, command.args, {
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
  });

  return {
    ok: true,
    applied: true,
    dryRun: false,
    reason,
    targetReplicas: command.targetReplicas,
    command: {
      bin: command.bin,
      args: redactCommandArgs(command.args),
      display: command.display,
    },
    railway: parseRailwayJsonOutput(stdout),
    stderr: String(stderr || '').trim().slice(0, 500) || null,
    completedAt: new Date().toISOString(),
    phiPolicy: {
      outputContainsRawPhi: false,
    },
  };
}

export const RAILWAY_SCALING_LIMITS = Object.freeze({
  maxReplicas: MAX_RAILWAY_REPLICAS,
  defaultRegion: DEFAULT_REGION,
});
