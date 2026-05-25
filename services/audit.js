/**
 * HIPAA Audit Logging Service
 *
 * Logs all access to Protected Health Information (PHI) for compliance.
 * Most writes are fire-and-forget, but high-risk exports/PHI reads can await
 * writeAudit() so audit durability is part of the request contract.
 */

import { db } from '../db/client.js';
import { auditLogs } from '../db/schema.js';

/**
 * Insert an audit log row and raise if it cannot be persisted. Await this in
 * routes where audit durability is part of the request contract.
 *
 * @param {Object} params
 * @param {string} params.userId - admin ID, clerk user ID, or 'cofounder'
 * @param {string} params.userRole - 'admin', 'caregiver', 'cofounder', or 'unknown'
 * @param {string} params.action - 'read', 'create', 'update', 'delete', 'auth_failure', 'shadow_decision'
 * @param {string} params.resourceType - 'senior', 'conversation', 'memory', 'reminder', 'call_analysis', 'auth'
 * @param {string|null} [params.resourceId] - UUID of the accessed resource (nullable for list endpoints)
 * @param {string|null} [params.ipAddress]
 * @param {string|null} [params.userAgent]
 * @param {Object|null} [params.metadata] - extra context (e.g., query params, filters)
 */
export async function writeAudit({ userId, userRole, action, resourceType, resourceId = null, ipAddress = null, userAgent = null, metadata = null }) {
  await db.insert(auditLogs).values({
    userId,
    userRole,
    action,
    resourceType,
    resourceId,
    ipAddress,
    userAgent,
    metadata: metadata || {},
  });
}

export function logAudit(params) {
  // Fire-and-forget: don't await, don't block
  writeAudit(params).then(() => {}).catch((err) => {
    console.error('[Audit] Log insert failed:', err.message);
  });
}

/**
 * Derive a role string from a req.auth object.
 *
 * @param {Object} auth - req.auth from middleware
 * @returns {string} 'cofounder', 'admin', or 'caregiver'
 */
export function authToRole(auth) {
  if (auth?.isCofounder) return 'cofounder';
  if (auth?.isAdmin) return 'admin';
  return 'caregiver';
}
