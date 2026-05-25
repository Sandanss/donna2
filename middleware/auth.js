/**
 * Authentication Middleware
 *
 * Uses Clerk for authentication with cofounder API key fallback.
 * Cofounders can never be locked out even if Clerk is down.
 *
 * Supports dual-key JWT for zero-downtime credential rotation:
 * set JWT_SECRET to the new key, JWT_SECRET_PREVIOUS to the old key,
 * and remove JWT_SECRET_PREVIOUS after all old tokens expire (7 days).
 *
 * Includes token revocation checks and audit logging for HIPAA compliance.
 */

import { clerkMiddleware, getAuth, clerkClient } from '@clerk/express';
import jwt from 'jsonwebtoken';
import { logAudit } from '../services/audit.js';
import { tokenRevocationService } from '../services/token-revocation.js';
import { DEFAULT_JWT_SECRET, isProductionEnv, timingSafeEqual } from '../lib/security-config.js';
import { createLogger } from '../lib/logger.js';
import { sendError } from '../lib/http-response.js';

const log = createLogger('Auth');

if (isProductionEnv() && (!process.env.JWT_SECRET || process.env.JWT_SECRET === DEFAULT_JWT_SECRET)) {
  throw new Error('JWT_SECRET environment variable is required in production (do not use the default)');
}
const JWT_SECRET = process.env.JWT_SECRET || DEFAULT_JWT_SECRET;
const JWT_SECRET_PREVIOUS = process.env.JWT_SECRET_PREVIOUS || '';

// Cofounder API keys from environment (comma-separated)
const COFOUNDER_API_KEYS = [
  process.env.COFOUNDER_API_KEY_1,
  process.env.COFOUNDER_API_KEY_2,
].filter(Boolean);

/**
 * Check if request has valid cofounder API key
 */
function isCofounderRequest(req) {
  const apiKey = req.headers['x-api-key'];
  return Boolean(apiKey && COFOUNDER_API_KEYS.some(key => timingSafeEqual(apiKey, key)));
}

/**
 * Try to verify a JWT with the current secret, then the previous one.
 * Returns decoded payload on success, or null if both fail.
 */
function verifyJwtDualKey(token) {
  const secrets = [JWT_SECRET, JWT_SECRET_PREVIOUS].filter(Boolean);
  for (const secret of secrets) {
    try {
      const decoded = jwt.verify(token, secret);
      return decoded;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Check if a token or its admin has been revoked.
 * In production, revocation storage failures fail closed instead of allowing
 * potentially revoked admin sessions through.
 */
async function checkTokenRevocation(token, adminId) {
  try {
    if (await tokenRevocationService.isTokenRevoked(token)) {
      return { revoked: true, message: 'Token has been revoked' };
    }
    if (await tokenRevocationService.isAdminRevoked(adminId)) {
      return { revoked: true, message: 'All sessions revoked — please log in again' };
    }
    return { revoked: false };
  } catch (err) {
    // Non-production compatibility fallback for pre-migration/dev DBs.
    // Production fails closed if revocation status cannot be checked.
    log.warn('Token revocation check skipped', {
      errorName: err?.name,
      errorCode: err?.code,
    });
    if (isProductionEnv()) {
      return {
        revoked: true,
        message: 'Token revocation status is unavailable',
      };
    }
    return { revoked: false };
  }
}

/**
 * Main auth middleware
 *
 * Checks in order:
 * 1. Cofounder API key (bypass Clerk entirely)
 * 2. Admin JWT Bearer token (dual-key for rotation + revocation check)
 * 3. Clerk session
 *
 * Sets req.auth with:
 * - isCofounder: boolean
 * - isAdmin: boolean (cofounder or Clerk admin role)
 * - userId: string (Clerk user ID or 'cofounder')
 */
export async function requireAuth(req, res, next) {
  // 1. Check for cofounder API key (can't be locked out)
  if (isCofounderRequest(req)) {
    req.auth = {
      isCofounder: true,
      isAdmin: true,
      userId: 'cofounder',
      provider: 'api_key',
    };
    return next();
  }

  // 2. Check for admin JWT Bearer token (dual-key for rotation)
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const decoded = verifyJwtDualKey(token);
    if (decoded) {
      // Check token revocation before granting access
      const revocation = await checkTokenRevocation(token, decoded.adminId);
      if (revocation.revoked) {
        return sendError(res, 401, { error: revocation.message });
      }
      req.auth = {
        isCofounder: false,
        isAdmin: true,
        userId: decoded.adminId,
        provider: 'admin_jwt',
      };
      return next();
    }
  }

  // 3. Check Clerk session
  try {
    const auth = getAuth(req);

    if (!auth || !auth.userId) {
      logAudit({
        userId: 'anonymous',
        userRole: 'unknown',
        action: 'auth_failure',
        resourceType: 'auth',
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
        metadata: { reason: 'no_clerk_session', path: req.path },
      });
      return sendError(res, 401, {
        error: 'Unauthorized',
        message: 'Authentication required',
      });
    }

    // Get user metadata to check for admin role
    let isAdmin = false;
    try {
      const user = await clerkClient.users.getUser(auth.userId);
      isAdmin = user.publicMetadata?.role === 'admin';
    } catch (err) {
      log.warn('Could not fetch user metadata', {
        errorName: err?.name,
        errorCode: err?.code,
      });
    }

    req.auth = {
      isCofounder: false,
      isAdmin,
      userId: auth.userId,
      provider: 'clerk',
    };

    next();
  } catch (error) {
    log.error('Clerk auth failed', {
      errorName: error?.name,
      errorCode: error?.code,
    });
    logAudit({
      userId: 'anonymous',
      userRole: 'unknown',
      action: 'auth_failure',
      resourceType: 'auth',
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      metadata: {
        reason: 'clerk_error',
        error_name: error?.name,
        error_code: error?.code,
        path: req.path,
      },
    });
    return sendError(res, 401, {
      error: 'Unauthorized',
      message: 'Invalid or expired session',
    });
  }
}

/**
 * Optional auth - sets req.auth if authenticated, but doesn't require it
 */
export async function optionalAuth(req, res, next) {
  if (isCofounderRequest(req)) {
    req.auth = {
      isCofounder: true,
      isAdmin: true,
      userId: 'cofounder',
      provider: 'api_key',
    };
    return next();
  }

  // Check for admin JWT Bearer token (dual-key for rotation)
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const decoded = verifyJwtDualKey(token);
    if (decoded) {
      // Check revocation even for optional auth
      const revocation = await checkTokenRevocation(token, decoded.adminId);
      if (!revocation.revoked) {
        req.auth = {
          isCofounder: false,
          isAdmin: true,
          userId: decoded.adminId,
          provider: 'admin_jwt',
        };
        return next();
      }
    }
  }

  try {
    const auth = getAuth(req);
    if (auth?.userId) {
      let isAdmin = false;
      try {
        const user = await clerkClient.users.getUser(auth.userId);
        isAdmin = user.publicMetadata?.role === 'admin';
      } catch (err) {
        // Ignore metadata fetch errors for optional auth
        log.warn('Could not fetch optional auth metadata', {
          errorName: err?.name,
          errorCode: err?.code,
        });
      }
      req.auth = {
        isCofounder: false,
        isAdmin,
        userId: auth.userId,
        provider: 'clerk',
      };
    }
  } catch (error) {
    // Ignore errors for optional auth
    log.warn('Optional auth skipped after Clerk error', {
      errorName: error?.name,
      errorCode: error?.code,
    });
  }

  next();
}

/**
 * Require admin role (cofounder or Clerk admin)
 */
export async function requireAdmin(req, res, next) {
  await requireAuth(req, res, () => {
    if (!req.auth?.isAdmin) {
      return sendError(res, 403, {
        error: 'Forbidden',
        message: 'Admin access required',
      });
    }
    next();
  });
}

/**
 * Clerk middleware initializer - must be used before requireAuth
 */
export { clerkMiddleware };

/**
 * Get Clerk user ID from request (for consumer app)
 */
export function getClerkUserId(req) {
  try {
    const auth = getAuth(req);
    return auth?.userId || null;
  } catch {
    return null;
  }
}

export default {
  requireAuth,
  requireAdmin,
  optionalAuth,
  clerkMiddleware,
  getClerkUserId,
};
