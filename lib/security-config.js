import crypto from 'crypto';

export const DEFAULT_JWT_SECRET = 'donna-admin-secret-change-me';

export function isProductionEnv(env = process.env) {
  return env.ENVIRONMENT === 'production' || Boolean(env.RAILWAY_PUBLIC_DOMAIN);
}

function isTruthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

function getTelephonyProvider(env = process.env) {
  return String(env.TELEPHONY_PROVIDER || 'telnyx').toLowerCase();
}

function hasRedisCompatibleSharedState(env = process.env) {
  return Boolean(
    env.REDIS_URL ||
    (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN)
  );
}

export function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));

  // Pad to equal length so crypto.timingSafeEqual always runs a real
  // comparison — prevents leaking the valid key's length via timing.
  const len = Math.max(bufA.length, bufB.length);
  const paddedA = Buffer.alloc(len);
  const paddedB = Buffer.alloc(len);
  bufA.copy(paddedA);
  bufB.copy(paddedB);

  const match = crypto.timingSafeEqual(paddedA, paddedB);
  return match && bufA.length === bufB.length;
}

export function parseServiceApiKeys(env = process.env) {
  const keys = new Map();
  const raw = env.DONNA_API_KEYS || '';

  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    const separator = trimmed.indexOf(':');
    if (separator <= 0 || separator === trimmed.length - 1) continue;

    const label = trimmed.slice(0, separator).trim();
    const key = trimmed.slice(separator + 1).trim();
    if (label && key) {
      keys.set(label, key);
    }
  }

  if (!isProductionEnv(env) && env.DONNA_API_KEY) {
    keys.set('legacy', env.DONNA_API_KEY);
  }

  return keys;
}

export function matchServiceApiKey(provided, env = process.env) {
  if (!provided) return null;

  for (const [label, key] of parseServiceApiKeys(env)) {
    if (timingSafeEqual(provided, key)) {
      return label;
    }
  }

  return null;
}

export function getServiceApiKey(label, env = process.env) {
  const keys = parseServiceApiKeys(env);
  return keys.get(label) || null;
}

export function getPipecatPublicUrl(env = process.env) {
  return env.PIPECAT_PUBLIC_URL || (!isProductionEnv(env) ? env.PIPECAT_BASE_URL : '') || '';
}

export function isValidFieldEncryptionKey(raw) {
  if (!raw) return false;

  try {
    return Buffer.from(raw, 'base64url').length === 32;
  } catch {
    return false;
  }
}

export function validateNodeSecurityConfig(env = process.env) {
  if (!isProductionEnv(env)) {
    return [];
  }

  const errors = [];
  if (!env.JWT_SECRET || env.JWT_SECRET === DEFAULT_JWT_SECRET) {
    errors.push('JWT_SECRET must be set to a non-default value');
  }
  if (parseServiceApiKeys(env).size === 0) {
    errors.push('DONNA_API_KEYS must contain at least one labeled key');
  }
  if (!isValidFieldEncryptionKey(env.FIELD_ENCRYPTION_KEY || '')) {
    errors.push('FIELD_ENCRYPTION_KEY must decode to 32 bytes');
  }
  if (getTelephonyProvider(env) !== 'telnyx') {
    errors.push('TELEPHONY_PROVIDER must be telnyx for voice calls');
  }
  if (!env.CLERK_SECRET_KEY) {
    errors.push('CLERK_SECRET_KEY is required for Clerk-authenticated routes');
  }
  if (!env.PIPECAT_PUBLIC_URL || !env.PIPECAT_PUBLIC_URL.startsWith('https://')) {
    errors.push('PIPECAT_PUBLIC_URL must be an https:// URL');
  }
  if (isTruthy(env.PIPECAT_REQUIRE_REDIS) && !hasRedisCompatibleSharedState(env)) {
    errors.push('REDIS_URL or UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN is required when PIPECAT_REQUIRE_REDIS=true');
  }
  if (isTruthy(env.REDIS_RATE_LIMITS_ENABLED) && !hasRedisCompatibleSharedState(env)) {
    errors.push('REDIS_URL or UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN is required when REDIS_RATE_LIMITS_ENABLED=true');
  }

  return errors;
}

export function assertNodeSecurityConfig(env = process.env) {
  const errors = validateNodeSecurityConfig(env);
  if (errors.length > 0) {
    throw new Error(`Production security configuration invalid: ${errors.join('; ')}`);
  }
}
