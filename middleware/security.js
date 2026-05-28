import crypto from 'crypto';
import helmet from 'helmet';

/**
 * Security headers middleware using helmet.
 * - Sets X-Content-Type-Options, X-Frame-Options, etc.
 * - CSP: no unsafe-inline scripts, encrypted WebSocket only
 */
export function securityHeaders() {
  return helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'", "wss:"],
      },
    },
    crossOriginEmbedderPolicy: false,
    strictTransportSecurity: {
      maxAge: 31536000, // 1 year
      includeSubDomains: true,
    },
    referrerPolicy: {
      policy: 'strict-origin-when-cross-origin',
    },
  });
}

/**
 * Request ID middleware - adds unique ID to each request for tracing.
 */
export function requestId() {
  return (req, res, next) => {
    const header = req.headers['x-request-id'];
    const candidate = Array.isArray(header) ? header[0] : header;
    req.id = isSafeRequestId(candidate) ? candidate : crypto.randomUUID();
    res.setHeader('X-Request-Id', req.id);
    next();
  };
}

function isSafeRequestId(value) {
  return typeof value === 'string' &&
    value.length >= 8 &&
    value.length <= 128 &&
    /^[A-Za-z0-9._:-]+$/.test(value);
}
