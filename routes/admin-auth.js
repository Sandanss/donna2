import { Router } from 'express';
import { db } from '../db/client.js';
import { adminUsers } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { authLimiter } from '../middleware/rate-limit.js';
import { requireAdmin } from '../middleware/auth.js';
import { tokenRevocationService } from '../services/token-revocation.js';
import { logAudit } from '../services/audit.js';
import { DEFAULT_JWT_SECRET, isProductionEnv } from '../lib/security-config.js';
import { routeError } from './helpers.js';
import { sendError } from '../lib/http-response.js';
import { createLogger } from '../lib/logger.js';

const router = Router();
const log = createLogger('AdminAuth');
if (isProductionEnv() && (!process.env.JWT_SECRET || process.env.JWT_SECRET === DEFAULT_JWT_SECRET)) {
  throw new Error('JWT_SECRET environment variable is required in production (do not use the default)');
}
const JWT_SECRET = process.env.JWT_SECRET || DEFAULT_JWT_SECRET;
const JWT_SECRET_PREVIOUS = process.env.JWT_SECRET_PREVIOUS || '';

/**
 * Try to verify a JWT with the current secret, then the previous one.
 */
function verifyJwtDualKey(token) {
  for (const secret of [JWT_SECRET, JWT_SECRET_PREVIOUS].filter(Boolean)) {
    try {
      return jwt.verify(token, secret);
    } catch {
      continue;
    }
  }
  return null;
}

// Login - no auth required
router.post('/api/admin/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const [admin] = await db.select().from(adminUsers)
      .where(eq(adminUsers.email, email.toLowerCase().trim()));

    if (!admin) {
      logAudit({
        userId: 'anonymous',
        userRole: 'unknown',
        action: 'auth_failure',
        resourceType: 'auth',
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
        metadata: { reason: 'unknown_email' },
      });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, admin.passwordHash);
    if (!valid) {
      logAudit({
        userId: admin.id,
        userRole: 'admin',
        action: 'auth_failure',
        resourceType: 'auth',
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
        metadata: { reason: 'wrong_password' },
      });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Update last login
    await db.update(adminUsers)
      .set({ lastLoginAt: new Date() })
      .where(eq(adminUsers.id, admin.id));

    const token = jwt.sign(
      { adminId: admin.id, email: admin.email },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    logAudit({
      userId: admin.id,
      userRole: 'admin',
      action: 'create',
      resourceType: 'auth',
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      metadata: { event: 'login_success' },
    });

    res.json({
      token,
      admin: { id: admin.id, email: admin.email, name: admin.name },
    });
  } catch (error) {
    routeError(res, error, 'POST /api/admin/login');
  }
});

// Get current admin - requires valid JWT (dual-key + revocation check)
router.get('/api/admin/me', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token' });
    }

    const token = authHeader.slice(7);
    const decoded = verifyJwtDualKey(token);

    if (!decoded) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    // Check token revocation
    try {
      const revocation = await tokenRevocationService.isTokenRevoked(token);
      if (revocation) {
        return res.status(401).json({ error: 'Token has been revoked' });
      }
      const adminRevoked = await tokenRevocationService.isAdminRevoked(decoded.adminId);
      if (adminRevoked) {
        return res.status(401).json({ error: 'All sessions revoked — please log in again' });
      }
    } catch (err) {
      log.warn('Token revocation check failed', {
        errorName: err?.name,
        errorCode: err?.code,
      });
      if (isProductionEnv()) {
        return sendError(res, 503, { error: 'Token revocation status is unavailable' });
      }
      // Local/dev pre-migration environments may not have the table yet.
    }

    const [admin] = await db.select({
      id: adminUsers.id,
      email: adminUsers.email,
      name: adminUsers.name,
      lastLoginAt: adminUsers.lastLoginAt,
    }).from(adminUsers)
      .where(eq(adminUsers.id, decoded.adminId));

    if (!admin) {
      return res.status(401).json({ error: 'Admin not found' });
    }

    res.json(admin);
  } catch (error) {
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      return sendError(res, 401, { error: 'Invalid or expired token' });
    }
    routeError(res, error, 'GET /api/admin/me');
  }
});

// Revoke a specific token (admin only)
router.post('/api/admin/revoke-token', requireAdmin, async (req, res) => {
  try {
    const { token, reason } = req.body;
    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }

    await tokenRevocationService.revokeToken(token, req.auth.userId, reason || '');
    res.json({ success: true, message: 'Token revoked' });
  } catch (error) {
    routeError(res, error, 'POST /api/admin/revoke-token');
  }
});

// Revoke all tokens for an admin (admin only — e.g. after password reset)
router.post('/api/admin/revoke-all', requireAdmin, async (req, res) => {
  try {
    const { adminId, reason } = req.body;
    if (!adminId) {
      return res.status(400).json({ error: 'adminId is required' });
    }

    await tokenRevocationService.revokeAllForAdmin(adminId, req.auth.userId, reason || '');
    res.json({ success: true, message: `All tokens revoked for admin ${adminId}` });
  } catch (error) {
    routeError(res, error, 'POST /api/admin/revoke-all');
  }
});

// Logout — revoke the caller's own token
router.post('/api/admin/logout', requireAdmin, async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader.slice(7);
    await tokenRevocationService.revokeToken(token, req.auth.userId, 'logout');
    res.json({ success: true, message: 'Logged out' });
  } catch (error) {
    routeError(res, error, 'POST /api/admin/logout');
  }
});

export default router;
