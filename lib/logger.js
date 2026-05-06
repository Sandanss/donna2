import { maskPhone, maskName, truncate, maskSensitiveText, sanitizeError } from './sanitize.js';

/**
 * Structured logger that sanitizes PII automatically.
 * Wraps console.log/error/warn with tag-based formatting.
 *
 * Usage:
 *   import { createLogger } from '../lib/logger.js';
 *   const log = createLogger('Memory');
 *   log.info('Stored memory', { seniorId: '...', content: 'long text...' });
 */
export function createLogger(tag) {
  const prefix = `[${tag}]`;

  return {
    info(message, meta = {}) {
      console.log(prefix, message, sanitizeMeta(meta));
    },
    warn(message, meta = {}) {
      console.warn(prefix, message, sanitizeMeta(meta));
    },
    error(message, meta = {}) {
      console.error(prefix, message, sanitizeMeta(meta));
    },
  };
}

/**
 * Auto-sanitize known PII fields in metadata objects.
 */
function sanitizeMeta(meta) {
  if (!meta || typeof meta !== 'object') return meta;
  if (meta instanceof Error) return sanitizeError(meta);
  if (Array.isArray(meta)) return meta.map(item => sanitizeMeta(item));

  const safe = {};
  for (const [key, value] of Object.entries(meta)) {
    safe[key] = sanitizeValue(key, value);
  }

  return safe;
}

function sanitizeValue(key, value) {
  if (value == null) return value;
  if (value instanceof Error) return sanitizeError(value);

  const normalizedKey = key.toLowerCase().replace(/[_-]/g, '');
  if (normalizedKey.includes('phone') || ['to', 'from', 'seniorphone', 'fromphone'].includes(normalizedKey)) {
    return maskPhone(String(value));
  }
  if (normalizedKey.includes('name')) {
    return maskName(String(value));
  }
  if (
    normalizedKey.includes('transcript') ||
    normalizedKey.includes('summary') ||
    normalizedKey.includes('content') ||
    normalizedKey.includes('description') ||
    normalizedKey.includes('medical') ||
    normalizedKey.includes('family') ||
    normalizedKey.includes('note') ||
    normalizedKey.includes('prompt') ||
    normalizedKey.includes('context') ||
    normalizedKey.includes('response')
  ) {
    return '[redacted]';
  }
  if (Array.isArray(value)) {
    return value.map(item => sanitizeMeta(item));
  }
  if (typeof value === 'object') {
    return sanitizeMeta(value);
  }
  if (typeof value === 'string') {
    return truncate(maskSensitiveText(value), 160);
  }
  return value;
}
