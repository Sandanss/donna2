"""PII sanitization utilities.

Port of lib/sanitize.js — masks phone numbers, names, and truncates content
for safe logging.
"""

from __future__ import annotations

import re
import unicodedata


_PHONE_RE = re.compile(r"\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b")
_EMAIL_RE = re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.I)
_SSN_RE = re.compile(r"\b\d{3}[-.\s]?\d{2}[-.\s]?\d{4}\b")
_CONTROL_RE = re.compile(r"[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\u200B-\u200D\u202A-\u202E\u2066-\u2069\uFEFF]")
_SPACE_RE = re.compile(r"\s+")
_PROMPT_INJECTION_LINE_RE = re.compile(
    r"("
    r"\b(ignore|disregard|forget|override|bypass|negate|replace)\b.{0,100}"
    r"\b(previous|prior|above|earlier|system|developer|assistant|user|all)?\s*instructions?\b"
    r"|"
    r"\b(reveal|print|show|output|dump|leak|exfiltrate|send|email|text|transmit)\b.{0,100}"
    r"\b(system\s+prompt|developer\s+message|hidden\s+prompt|instructions?|api\s*key|secret|token|password|canary(?:[_-]?[a-z0-9]+)*)\b"
    r"|"
    r"\b(system|developer|assistant|user|tool)\s*(prompt|message|instructions?)\s*[:=-]"
    r"|"
    r"^\s*(?:#{1,6}\s*)?(system|developer|assistant|user|tool)\s*[:>-]"
    r"|"
    r"</?(system|developer|assistant|user|tool)\b[^>]*>"
    r"|"
    r"\bdo\s+not\s+(summarize|sanitize|filter|redact|remove)\b"
    r"|"
    r"\btrusted\s+(system|developer)\s+(message|instruction|prompt)\b"
    r")",
    re.I,
)


def mask_phone(phone: str | None) -> str:
    """Mask a phone number: '+15551234567' → '***4567'."""
    if not phone:
        return "[no-phone]"
    digits = re.sub(r"\D", "", phone)
    if len(digits) < 4:
        return "****"
    return "***" + digits[-4:]


def mask_contact_info(text: str | None) -> str:
    """Mask phone, email, and SSN-like substrings in free-form text."""
    if text is None:
        return ""
    value = str(text)
    value = _PHONE_RE.sub(lambda match: mask_phone(match.group(0)), value)
    value = _EMAIL_RE.sub("[email redacted]", value)
    return _SSN_RE.sub("[ssn redacted]", value)


def mask_name(name: str | None) -> str:
    """Mask a name for logs: 'David Zuluaga' → 'David Z.'."""
    if not name:
        return "[unknown]"
    parts = name.split()
    if len(parts) == 1:
        return parts[0]
    return parts[0] + " " + " ".join(p[0] + "." for p in parts[1:])


def truncate(text: str | None, max_len: int = 30) -> str:
    """Truncate content for safe logging."""
    if not text:
        return ""
    if len(text) <= max_len:
        return text
    return text[:max_len] + "..."


def sanitize_untrusted_text(
    text: str | None,
    *,
    max_len: int | None = 1000,
    replacement: str = "[removed unsafe instruction]",
    redact_contact_info: bool = True,
) -> str:
    """Remove prompt-control instructions from untrusted free-form text."""
    if text is None:
        return ""

    value = unicodedata.normalize("NFKC", str(text))
    value = _CONTROL_RE.sub("", value)
    if redact_contact_info:
        value = mask_contact_info(value)

    safe_lines: list[str] = []
    removed = False
    for raw_line in value.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if _PROMPT_INJECTION_LINE_RE.search(line):
            removed = True
            continue
        safe_lines.append(line)

    value = _SPACE_RE.sub(" ", " ".join(safe_lines)).strip()
    if not value and removed:
        value = replacement
    if max_len and len(value) > max_len:
        value = truncate(value, max_len)
    return value
