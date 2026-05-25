"""Field-level encryption for PHI data at rest.

Uses AES-256-GCM for symmetric encryption. Key is loaded from
FIELD_ENCRYPTION_KEY env var (32 bytes, base64url-encoded).

Both Python and Node.js backends use the same format:
    enc:<iv_b64>:<tag_b64>:<ciphertext_b64>

Local/test can skip encryption when FIELD_ENCRYPTION_KEY is absent. Public
production-style environments fail closed. Legacy unencrypted data (no
'enc:' prefix) is returned as-is on decrypt.
"""

from __future__ import annotations

import base64
import json
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from loguru import logger
from config import is_production_environment

_KEY: bytes | None = None
_aes: AESGCM | None = None


def _get_aes() -> AESGCM | None:
    """Lazily initialize AES-256-GCM cipher from env var."""
    global _KEY, _aes
    if _aes is not None:
        return _aes
    raw = os.getenv("FIELD_ENCRYPTION_KEY", "")
    if not raw:
        if is_production_environment():
            raise RuntimeError("FIELD_ENCRYPTION_KEY is required for PHI encryption in production")
        return None
    try:
        padded = raw + "=" * (-len(raw) % 4)
        _KEY = base64.urlsafe_b64decode(padded)
        if len(_KEY) != 32:
            logger.error(
                "FIELD_ENCRYPTION_KEY must decode to 32 bytes, got {n}",
                n=len(_KEY),
            )
            if is_production_environment():
                raise RuntimeError("FIELD_ENCRYPTION_KEY must decode to 32 bytes")
            return None
        _aes = AESGCM(_KEY)
        return _aes
    except Exception as e:
        logger.error("Invalid FIELD_ENCRYPTION_KEY: {err}", err=str(e))
        if is_production_environment():
            raise
        return None


# --------------------------------------------------------------------------- #
# Public API
# --------------------------------------------------------------------------- #

def encrypt(plaintext: str | None) -> str | None:
    """Encrypt a string value.

    Returns ``enc:<iv_b64>:<tag_b64>:<ciphertext_b64>`` or the original
    plaintext if no key is configured.
    """
    if plaintext is None:
        return None
    aes = _get_aes()
    if aes is None:
        return plaintext  # graceful degradation

    nonce = os.urandom(12)  # 96-bit nonce for GCM
    ct_with_tag = aes.encrypt(nonce, plaintext.encode("utf-8"), None)
    # AES-GCM appends a 16-byte tag to the ciphertext
    ciphertext = ct_with_tag[:-16]
    tag = ct_with_tag[-16:]
    parts = [
        base64.b64encode(nonce).decode(),
        base64.b64encode(tag).decode(),
        base64.b64encode(ciphertext).decode(),
    ]
    return "enc:" + ":".join(parts)


def decrypt(ciphertext: str | None) -> str | None:
    """Decrypt a string value.

    Handles both encrypted (``enc:`` prefix) and legacy unencrypted data.
    """
    if ciphertext is None:
        return None
    if not isinstance(ciphertext, str) or not ciphertext.startswith("enc:"):
        return ciphertext  # legacy unencrypted data
    aes = _get_aes()
    if aes is None:
        logger.warning("Cannot decrypt: FIELD_ENCRYPTION_KEY not set")
        return "[encrypted]"
    parts = ciphertext[4:].split(":")
    if len(parts) != 3:
        return ciphertext  # not our format
    try:
        nonce = base64.b64decode(parts[0])
        tag = base64.b64decode(parts[1])
        ct = base64.b64decode(parts[2])
        plaintext_bytes = aes.decrypt(nonce, ct + tag, None)
        return plaintext_bytes.decode("utf-8")
    except Exception as e:
        logger.error("Decryption failed: {err}", err=str(e))
        return "[encrypted]"


def encrypt_json(data: dict | list | None) -> str | None:
    """Encrypt a JSON-serializable object. Returns encrypted string."""
    if data is None:
        return None
    return encrypt(json.dumps(data, default=str))


def decrypt_json(ciphertext) -> dict | list | None:
    """Decrypt to a JSON object.

    Handles encrypted strings, legacy JSONB (already deserialized by asyncpg),
    and plain JSON strings.
    """
    if ciphertext is None:
        return None
    # asyncpg's JSONB codec may have already deserialized this
    if isinstance(ciphertext, (dict, list)):
        return ciphertext
    plaintext = decrypt(ciphertext)
    if plaintext == "[encrypted]":
        return None
    if isinstance(plaintext, (dict, list)):
        return plaintext
    try:
        return json.loads(plaintext)
    except (json.JSONDecodeError, TypeError):
        return plaintext


def generate_key() -> str:
    """Generate a new 32-byte base64url-encoded key.

    Run once and store the result in FIELD_ENCRYPTION_KEY env var::

        python -c "from lib.encryption import generate_key; print(generate_key())"
    """
    return base64.urlsafe_b64encode(os.urandom(32)).decode()
