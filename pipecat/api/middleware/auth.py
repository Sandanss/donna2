"""Authentication middleware.

Port of middleware/auth.js — 3-tier auth:
1. Cofounder API key (bypass everything)
2. Admin JWT Bearer token (dual-key: JWT_SECRET + JWT_SECRET_PREVIOUS)
3. Clerk session (JWKS-verified RS256)

Includes token revocation checks and audit logging for HIPAA compliance.
Implemented as FastAPI Depends() callables.
"""

from __future__ import annotations

import base64
import hmac
import os
from dataclasses import dataclass

import jwt
from jwt import PyJWKClient
from fastapi import HTTPException, Request
from loguru import logger
from config import DEFAULT_JWT_SECRET, is_production_environment, parse_service_api_keys

# JWT secrets — required in production.
# JWT_SECRET_PREVIOUS enables zero-downtime credential rotation:
# set the new secret as JWT_SECRET, move the old one to JWT_SECRET_PREVIOUS,
# and remove JWT_SECRET_PREVIOUS after all old tokens expire (7 days).
if is_production_environment() and (
    not os.getenv("JWT_SECRET") or os.getenv("JWT_SECRET") == DEFAULT_JWT_SECRET
):
    raise RuntimeError("JWT_SECRET environment variable is required in production (do not use the default)")

JWT_SECRET = os.getenv("JWT_SECRET", DEFAULT_JWT_SECRET)
JWT_SECRET_PREVIOUS = os.getenv("JWT_SECRET_PREVIOUS", "")

# Cofounder API keys (comma-separated env vars)
COFOUNDER_API_KEYS = [
    k for k in [
        os.getenv("COFOUNDER_API_KEY_1"),
        os.getenv("COFOUNDER_API_KEY_2"),
    ] if k
]


def _derive_clerk_jwks_url() -> str | None:
    """Derive the Clerk JWKS URL from environment variables.

    Priority:
    1. Explicit CLERK_JWKS_URL env var
    2. Derive from CLERK_PUBLISHABLE_KEY (base64-encoded domain after 'pk_test_' or 'pk_live_')

    Returns None if neither is available.
    """
    explicit_url = os.getenv("CLERK_JWKS_URL")
    if explicit_url:
        return explicit_url

    pub_key = os.getenv("CLERK_PUBLISHABLE_KEY") or os.getenv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY")
    if not pub_key:
        return None

    try:
        # Clerk publishable key format: pk_test_<base64domain>$ or pk_live_<base64domain>$
        # The base64 part encodes the Clerk frontend API domain
        parts = pub_key.split("_", 2)
        if len(parts) < 3:
            return None
        encoded = parts[2]
        # Strip trailing '$' if present, add base64 padding
        encoded = encoded.rstrip("$")
        padded = encoded + "=" * (-len(encoded) % 4)
        domain = base64.b64decode(padded).decode("utf-8")
        if domain:
            return f"https://{domain}/.well-known/jwks.json"
    except Exception as exc:
        logger.warning(f"Failed to derive Clerk JWKS URL from publishable key: {exc}")

    return None


# --- Clerk JWKS client (cached, handles key rotation internally) ---
_clerk_jwks_url = _derive_clerk_jwks_url()
_clerk_jwk_client: PyJWKClient | None = None

if _clerk_jwks_url:
    try:
        _clerk_jwk_client = PyJWKClient(
            _clerk_jwks_url,
            cache_keys=True,
            lifespan=3600,  # Re-fetch keys every hour (handles rotation)
        )
        logger.info(f"Clerk JWKS client initialized: {_clerk_jwks_url}")
    except Exception as exc:
        logger.error(f"Failed to initialize Clerk JWKS client: {exc}")
        _clerk_jwk_client = None
else:
    if os.getenv("CLERK_SECRET_KEY"):
        logger.warning(
            "CLERK_SECRET_KEY is set but no JWKS URL could be derived. "
            "Set CLERK_JWKS_URL or CLERK_PUBLISHABLE_KEY to enable "
            "Clerk JWT signature verification."
        )


@dataclass
class AuthContext:
    """Authentication context attached to each request."""
    is_cofounder: bool = False
    is_admin: bool = False
    user_id: str = ""
    clerk_user_id: str | None = None


def _verify_jwt_dual_key(token: str) -> dict | None:
    """Try to verify a JWT with the current secret, then the previous one.

    Returns the decoded payload on success, or None if both fail.
    """
    for secret in [JWT_SECRET, JWT_SECRET_PREVIOUS]:
        if not secret:
            continue
        try:
            return jwt.decode(token, secret, algorithms=["HS256"])
        except jwt.InvalidTokenError:
            continue
    return None


async def _check_token_revocation(token: str, admin_id: str) -> None:
    """Check if a token or its admin has been revoked. Raises 401 if so."""
    try:
        from services.token_revocation import is_token_revoked, is_admin_revoked

        if await is_token_revoked(token):
            raise HTTPException(status_code=401, detail="Token has been revoked")
        if await is_admin_revoked(admin_id):
            raise HTTPException(status_code=401, detail="All sessions revoked — please log in again")
    except HTTPException:
        raise
    except Exception as e:
        logger.debug("Token revocation check skipped: {err}", err=str(e))
        if is_production_environment():
            raise HTTPException(
                status_code=503,
                detail="Token revocation status is unavailable",
            )


async def require_auth(request: Request) -> AuthContext:
    """3-tier auth dependency: cofounder API key → JWT (dual-key) → Clerk.

    Usage: auth = Depends(require_auth)
    """
    # 1. Cofounder API key
    api_key = request.headers.get("x-api-key", "")
    if api_key and any(hmac.compare_digest(api_key, key) for key in COFOUNDER_API_KEYS):
        return AuthContext(is_cofounder=True, is_admin=True, user_id="cofounder")

    # 2. Admin JWT Bearer token (dual-key for rotation)
    auth_header = request.headers.get("authorization", "")
    if auth_header.startswith("Bearer "):
        token = auth_header[7:]
        decoded = _verify_jwt_dual_key(token)
        if decoded:
            admin_id = decoded.get("adminId", "")
            # Check token revocation before granting access
            await _check_token_revocation(token, admin_id)
            return AuthContext(
                is_cofounder=False,
                is_admin=True,
                user_id=admin_id,
            )

    # 3. Clerk session — JWKS-verified RS256 signature
    clerk_token = request.headers.get("x-clerk-token") or request.cookies.get("__session")
    if clerk_token:
        if not _clerk_jwk_client:
            logger.warning("Clerk token received but JWKS client not configured — rejecting")
            raise HTTPException(status_code=401, detail="Authentication required")

        try:
            signing_key = _clerk_jwk_client.get_signing_key_from_jwt(clerk_token)
            decoded = jwt.decode(
                clerk_token,
                signing_key.key,
                algorithms=["RS256"],
                options={
                    "verify_signature": True,
                    "verify_exp": True,
                    "verify_aud": False,  # Clerk tokens don't always set aud
                },
            )
            user_id = decoded.get("sub", "")
            if user_id:
                return AuthContext(
                    is_cofounder=False,
                    is_admin=False,
                    user_id=user_id,
                    clerk_user_id=user_id,
                )
        except jwt.ExpiredSignatureError:
            logger.debug("Clerk token expired")
        except jwt.InvalidTokenError as exc:
            logger.debug("Clerk token validation failed: {err_type}", err_type=type(exc).__name__)
        except Exception as exc:
            # Network failures fetching JWKS, unexpected errors — log and reject
            logger.warning("Clerk JWKS verification error: {err_type}", err_type=type(exc).__name__)

    # Audit: log failed auth attempt
    try:
        from services.audit import fire_and_forget_audit
        fire_and_forget_audit(
            user_id="anonymous",
            user_role="unknown",
            action="auth_failure",
            resource_type="auth",
            ip_address=request.client.host if request.client else None,
            user_agent=request.headers.get("user-agent"),
            metadata={"reason": "no_valid_credentials", "path": str(request.url.path)},
        )
    except Exception:
        pass  # Never let audit logging break auth flow

    raise HTTPException(status_code=401, detail="Authentication required")


async def optional_auth(request: Request) -> AuthContext | None:
    """Same checks as require_auth but returns None instead of raising."""
    try:
        return await require_auth(request)
    except HTTPException:
        return None


async def require_admin(request: Request) -> AuthContext:
    """Require admin-level auth (cofounder or admin JWT)."""
    auth = await require_auth(request)
    if not auth.is_admin:
        raise HTTPException(status_code=403, detail="Admin access required")
    return auth


async def require_service_api_key(request: Request) -> str:
    """Require a labeled service API key from DONNA_API_KEYS.

    This is for backend-to-backend calls where a frontend user token should not
    be forwarded across service boundaries.
    """
    provided = request.headers.get("x-api-key", "")
    if not provided:
        auth_header = request.headers.get("authorization", "")
        if auth_header.startswith("Bearer "):
            provided = auth_header[7:]

    for label, key in parse_service_api_keys().items():
        if provided and hmac.compare_digest(str(provided), str(key)):
            return label

    raise HTTPException(status_code=401, detail="Service authentication required")
