/**
 * PII sanitization utilities.
 * Masks phone numbers, limits content previews, redacts sensitive fields.
 */

const PHONE_PATTERN = /(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/g;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const SSN_PATTERN = /\b\d{3}[-.\s]?\d{2}[-.\s]?\d{4}\b/g;
const CONTROL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200D\u202A-\u202E\u2066-\u2069\uFEFF]/g;
const SPACE_PATTERN = /\s+/g;

const PROMPT_INJECTION_LINE_PATTERNS = [
  /\b(ignore|disregard|forget|override|bypass|negate|replace)\b.{0,100}\b(previous|prior|above|earlier|system|developer|assistant|user|all)?\s*instructions?\b/i,
  /\b(reveal|print|show|output|dump|leak|exfiltrate|send|email|text|transmit)\b.{0,100}\b(system\s+prompt|developer\s+message|hidden\s+prompt|instructions?|api\s*key|secret|token|password|canary(?:[_-]?[a-z0-9]+)*)\b/i,
  /\b(system|developer|assistant|user|tool)\s*(prompt|message|instructions?)\s*[:=-]/i,
  /^\s*(?:#{1,6}\s*)?(system|developer|assistant|user|tool)\s*[:>-]/i,
  /<\/?(system|developer|assistant|user|tool)\b[^>]*>/i,
  /\bdo\s+not\s+(summarize|sanitize|filter|redact|remove)\b/i,
  /\btrusted\s+(system|developer)\s+(message|instruction|prompt)\b/i,
];

/**
 * Mask a phone number: "5551234567" -> "***4567"
 */
export function maskPhone(phone) {
  if (!phone) return '[no-phone]';
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 4) return '****';
  return '***' + digits.slice(-4);
}

/**
 * Truncate content for safe logging: "long string..." -> "long str..."
 */
export function truncate(str, maxLen = 30) {
  if (!str) return '';
  const value = String(str);
  if (value.length <= maxLen) return value;
  return value.substring(0, maxLen) + '...';
}

/**
 * Mask a senior name for logs: "David Zuluaga" -> "David Z."
 */
export function maskName(name) {
  if (!name) return '[unknown]';
  const parts = name.split(' ');
  if (parts.length === 1) return parts[0];
  return parts[0] + ' ' + parts.slice(1).map(p => p[0] + '.').join(' ');
}

/**
 * Mask phone-looking substrings inside free-form error messages.
 */
export function maskPhonesInText(text) {
  if (text == null) return text;
  return String(text).replace(PHONE_PATTERN, match => maskPhone(match));
}

export function maskEmailsInText(text) {
  if (text == null) return text;
  return String(text).replace(EMAIL_PATTERN, '[email redacted]');
}

export function maskSensitiveText(text) {
  if (text == null) return text;
  return maskEmailsInText(maskPhonesInText(String(text))).replace(SSN_PATTERN, '[ssn redacted]');
}

function isUnsafePromptLine(line) {
  return PROMPT_INJECTION_LINE_PATTERNS.some(pattern => pattern.test(line));
}

/**
 * Remove prompt-control instructions from untrusted text before it can be sent
 * to users, vendors, or future LLM prompts.
 */
export function sanitizeUntrustedMessageText(text, options = {}) {
  if (text == null) return '';
  const {
    maxLen = 1000,
    replacement = '[removed unsafe instruction]',
    redactContactInfo = true,
  } = options;

  let value = String(text).normalize('NFKC').replace(CONTROL_PATTERN, '');
  if (redactContactInfo) {
    value = maskSensitiveText(value);
  }

  const safeLines = [];
  let removed = false;

  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (isUnsafePromptLine(line)) {
      removed = true;
      continue;
    }
    safeLines.push(line);
  }

  value = safeLines.join(' ').replace(SPACE_PATTERN, ' ').trim();
  if (!value && removed) {
    value = replacement;
  }
  if (maxLen && value.length > maxLen) {
    value = truncate(value, maxLen);
  }
  return value;
}

/**
 * Return a safe, non-PHI error summary for structured logs.
 */
export function sanitizeError(error) {
  if (!error) return null;
  return {
    name: error.name || 'Error',
    code: error.code,
    message: truncate(maskSensitiveText(error.message || String(error)), 160),
  };
}
