import { createHash, createHmac } from 'crypto';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { idempotencyKeys } from '../db/schema.js';
import { decryptJson, encryptJson } from '../lib/encryption.js';
import { createLogger } from '../lib/logger.js';
import { getRequestId, sendError } from '../lib/http-response.js';

const log = createLogger('Idempotency');

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const IDEMPOTENT_METHODS = new Set(['POST', 'PATCH', 'DELETE']);
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{16,255}$/;

function getIdempotencyKey(req) {
  const header = req.headers['idempotency-key'];
  return Array.isArray(header) ? header[0] : header;
}

function errorChain(error) {
  const chain = [];
  let current = error;
  while (current && !chain.includes(current)) {
    chain.push(current);
    current = current.cause;
  }
  return chain;
}

function isStorageUnavailableError(error) {
  return errorChain(error).some((entry) => {
    const message = String(entry?.message || '');
    return entry?.code === '42P01' ||
      entry?.code === '42703' ||
      (/idempotency_keys/i.test(message) && /does not exist|relation|column/i.test(message));
  });
}

function canonicalStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringify).join(',')}]`;
  }

  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`)
    .join(',')}}`;
}

function hashValue(value) {
  const secret = process.env.IDEMPOTENCY_HASH_KEY || process.env.FIELD_ENCRYPTION_KEY || '';
  if (secret) {
    return createHmac('sha256', secret).update(value).digest('hex');
  }
  return createHash('sha256').update(value).digest('hex');
}

function hashRequestBody(body) {
  return hashValue(canonicalStringify(body ?? {}));
}

function hashRequestPath(req) {
  return hashValue(req.originalUrl?.split('?')[0] || `${req.baseUrl || ''}${req.path || ''}`);
}

function replayConflict(res) {
  return sendError(res, 409, {
    error: 'Idempotency conflict',
    code: 'idempotency_key_reused',
    message: 'This Idempotency-Key was already used with a different request.',
  });
}

function requestInProgress(res, existing) {
  return sendError(res, 409, {
    error: 'Request already in progress',
    code: 'request_processing',
    message: 'A matching request is still being processed. Please retry shortly.',
    ...(existing?.requestId ? { originalRequestId: existing.requestId } : {}),
  });
}

async function findExisting(key) {
  const [existing] = await db.select()
    .from(idempotencyKeys)
    .where(eq(idempotencyKeys.key, key))
    .limit(1);
  return existing || null;
}

async function claimProcessingRecord({ key, userId, method, pathHash, bodyHash, requestId }) {
  const expiresAt = new Date(Date.now() + IDEMPOTENCY_TTL_MS);
  const record = {
    key,
    userId,
    method,
    pathHash,
    bodyHash,
    state: 'processing',
    statusCode: null,
    responseEncrypted: null,
    requestId,
    createdAt: new Date(),
    expiresAt,
  };

  const result = await db.execute(sql`
    INSERT INTO idempotency_keys (
      key,
      user_id,
      method,
      path_hash,
      body_hash,
      state,
      status_code,
      response_encrypted,
      request_id,
      created_at,
      expires_at
    )
    VALUES (
      ${record.key},
      ${record.userId},
      ${record.method},
      ${record.pathHash},
      ${record.bodyHash},
      ${record.state},
      ${record.statusCode},
      ${record.responseEncrypted},
      ${record.requestId},
      ${record.createdAt},
      ${record.expiresAt}
    )
    ON CONFLICT (key) DO UPDATE SET
      user_id = EXCLUDED.user_id,
      method = EXCLUDED.method,
      path_hash = EXCLUDED.path_hash,
      body_hash = EXCLUDED.body_hash,
      state = EXCLUDED.state,
      status_code = NULL,
      response_encrypted = NULL,
      request_id = EXCLUDED.request_id,
      created_at = EXCLUDED.created_at,
      expires_at = EXCLUDED.expires_at
    WHERE idempotency_keys.expires_at < NOW()
    RETURNING key
  `);

  return (result.rows?.length ?? 0) > 0;
}

function isEncryptedPayload(value) {
  return typeof value === 'string' && value.startsWith('enc:');
}

async function completeRecord(key, statusCode, body, requestId) {
  const responseEncrypted = encryptJson({ body: body ?? null });
  if (!isEncryptedPayload(responseEncrypted)) {
    await clearRecord(key, requestId);
    log.warn('Skipped idempotency response cache because encrypted storage is unavailable', {
      requestId,
    });
    return;
  }

  await db.update(idempotencyKeys)
    .set({
      state: 'completed',
      statusCode,
      responseEncrypted,
      requestId,
    })
    .where(eq(idempotencyKeys.key, key));
}

async function clearRecord(key, requestId) {
  try {
    await db.delete(idempotencyKeys).where(eq(idempotencyKeys.key, key));
  } catch (error) {
    log.warn('Failed to clear idempotency key', {
      requestId,
      errorCode: error?.code,
    });
  }
}

function sameRequest(existing, { userId, method, pathHash, bodyHash }) {
  return existing.userId === userId &&
    existing.method === method &&
    existing.pathHash === pathHash &&
    existing.bodyHash === bodyHash;
}

function expired(existing) {
  return existing.expiresAt && new Date(existing.expiresAt).getTime() <= Date.now();
}

function shouldSkipResponseCache(req, res) {
  if (res.locals?.skipIdempotencyCache) return true;
  const path = req.originalUrl?.split('?')[0] || `${req.baseUrl || ''}${req.path || ''}`;
  return req.method === 'DELETE' && (
    /^\/api\/seniors\/[^/]+\/data$/.test(path) ||
    /^\/api\/prospects\/[^/]+\/data$/.test(path) ||
    path === '/api/caregivers/me/account'
  );
}

export async function idempotencyMiddleware(req, res, next) {
  if (!IDEMPOTENT_METHODS.has(req.method)) {
    return next();
  }

  const key = getIdempotencyKey(req);
  if (!key) {
    return next();
  }

  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    return sendError(res, 400, {
      error: 'Invalid Idempotency-Key',
      code: 'invalid_idempotency_key',
      message: 'Use 16-255 characters: letters, numbers, periods, underscores, colons, or hyphens.',
    });
  }

  const userId = req.auth?.userId;
  if (!userId) {
    return next();
  }

  const request = {
    userId,
    method: req.method,
    pathHash: hashRequestPath(req),
    bodyHash: hashRequestBody(req.body),
  };

  try {
    const claimed = await claimProcessingRecord({
      key,
      ...request,
      requestId: getRequestId(req),
    });

    if (!claimed) {
      const existing = await findExisting(key);
      if (!existing || expired(existing)) {
        return requestInProgress(res, existing);
      }

      if (!sameRequest(existing, request)) {
        return replayConflict(res);
      }

      if (existing.state === 'completed' && existing.responseEncrypted) {
        const cached = decryptJson(existing.responseEncrypted);
        const body = cached && typeof cached === 'object' && Object.hasOwn(cached, 'body')
          ? cached.body
          : cached;
        res.setHeader('Idempotency-Status', 'replayed');
        if (existing.requestId) {
          res.setHeader('X-Original-Request-Id', existing.requestId);
        }
        return res.status(existing.statusCode || 200).json(body ?? {});
      }

      return requestInProgress(res, existing);
    }
  } catch (error) {
    if (isStorageUnavailableError(error)) {
      log.warn('Idempotency storage unavailable; continuing without replay protection', {
        requestId: getRequestId(req),
        errorName: error?.name,
        errorCode: error?.code,
      });
      return next();
    }

    log.error('Idempotency setup failed', {
      requestId: getRequestId(req),
      errorName: error?.name,
      errorCode: error?.code,
    });
    return sendError(res, 503, {
      error: 'Request replay protection is unavailable',
      code: 'idempotency_unavailable',
      message: 'Please retry shortly.',
    });
  }

  const originalJson = res.json.bind(res);
  res.json = (body) => {
    if (shouldSkipResponseCache(req, res)) {
      clearRecord(key, getRequestId(req))
        .finally(() => originalJson(body));
      return res;
    }

    if (res.statusCode >= 200 && res.statusCode < 300) {
      completeRecord(key, res.statusCode, body, getRequestId(req))
        .catch((error) => {
          log.error('Failed to store idempotent response', {
            requestId: getRequestId(req),
            errorName: error?.name,
            errorCode: error?.code,
          });
        })
        .finally(() => originalJson(body));
      return res;
    }

    clearRecord(key, getRequestId(req))
      .finally(() => originalJson(body));
    return res;
  };

  next();
}

export default idempotencyMiddleware;
