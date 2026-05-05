import { isProductionEnv, matchServiceApiKey, parseServiceApiKeys } from '../lib/security-config.js';
import { sendError } from '../lib/http-response.js';

/**
 * API key authentication middleware.
 * Reads DONNA_API_KEYS from environment. If set, all /api/* routes
 * require Authorization: Bearer <key> header.
 * If no service API keys are set, auth is disabled outside production only.
 */
// Route prefixes that use their own auth (JWT or Clerk) instead of API key.
// Express mounts this middleware at /api, so req.path is the path after /api.
const EXEMPT_PATHS = [
  '/admin',
  '/observability',
  '/caregivers',
  '/seniors',
  '/reminders',
  '/onboarding',
  '/call',
  '/calls',
  '/conversations',
  '/notifications',
  '/stats',
  '/call-analyses',
  '/daily-context',
  '/chat',
];

export function requireApiKey(req, res, next) {
  const configuredKeys = parseServiceApiKeys();

  // If no API key configured, skip auth outside production only.
  if (configuredKeys.size === 0) {
    if (isProductionEnv()) {
      return sendError(res, 503, { error: 'Service API key auth is not configured' });
    }
    return next();
  }

  // Skip API key for routes that handle their own auth (JWT-based)
  if (isApiKeyExemptPath(req.path)) {
    return next();
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return sendError(res, 401, { error: 'Authorization required' });
  }

  const token = authHeader.slice(7);
  const keyLabel = matchServiceApiKey(token);
  if (!keyLabel) {
    return sendError(res, 403, { error: 'Invalid API key' });
  }

  req.serviceApiKeyLabel = keyLabel;
  next();
}

export function isApiKeyExemptPath(path) {
  const normalizedPath = normalizeApiPath(path);

  return EXEMPT_PATHS.some(
    exemptPath =>
      normalizedPath === exemptPath ||
      normalizedPath.startsWith(`${exemptPath}/`),
  );
}

function normalizeApiPath(path) {
  if (!path || path === '/') return '/';
  return path.replace(/\/+$/, '') || '/';
}
