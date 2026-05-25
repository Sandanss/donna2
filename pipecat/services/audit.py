"""HIPAA audit logging service.

Logs all access to Protected Health Information (PHI) for compliance.
Use `fire_and_forget_audit()` for best-effort paths and `write_audit()` where
audit durability is part of the request contract.
"""

from __future__ import annotations

import asyncio
import json

from loguru import logger

from db.client import execute


async def log_audit(
    user_id: str,
    user_role: str,
    action: str,
    resource_type: str,
    resource_id: str | None = None,
    ip_address: str | None = None,
    user_agent: str | None = None,
    metadata: dict | None = None,
    raise_on_error: bool = False,
) -> None:
    """Insert an audit log row.

    By default this logs and swallows failures for latency-sensitive paths.
    Set raise_on_error=True for high-risk PHI exports where audit durability
    should be part of the request contract.
    """
    try:
        await execute(
            """INSERT INTO audit_logs
               (user_id, user_role, action, resource_type, resource_id,
                ip_address, user_agent, metadata)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)""",
            user_id,
            user_role,
            action,
            resource_type,
            resource_id,
            ip_address,
            user_agent,
            json.dumps(metadata) if metadata else "{}",
        )
    except Exception as e:
        logger.error("Audit log insert failed: {err}", err=str(e))
        if raise_on_error:
            raise


async def write_audit(
    user_id: str,
    user_role: str,
    action: str,
    resource_type: str,
    resource_id: str | None = None,
    ip_address: str | None = None,
    user_agent: str | None = None,
    metadata: dict | None = None,
) -> None:
    """Insert an audit log row and raise if it cannot be persisted."""
    await log_audit(
        user_id=user_id,
        user_role=user_role,
        action=action,
        resource_type=resource_type,
        resource_id=resource_id,
        ip_address=ip_address,
        user_agent=user_agent,
        metadata=metadata,
        raise_on_error=True,
    )


def fire_and_forget_audit(
    user_id: str,
    user_role: str,
    action: str,
    resource_type: str,
    resource_id: str | None = None,
    ip_address: str | None = None,
    user_agent: str | None = None,
    metadata: dict | None = None,
) -> None:
    """Schedule an audit log write without awaiting it.

    Use this in route handlers so the audit INSERT never adds latency.
    """
    asyncio.create_task(log_audit(
        user_id=user_id,
        user_role=user_role,
        action=action,
        resource_type=resource_type,
        resource_id=resource_id,
        ip_address=ip_address,
        user_agent=user_agent,
        metadata=metadata,
    ))


def auth_to_role(auth) -> str:
    """Derive a role string from an AuthContext object."""
    if auth.is_cofounder:
        return "cofounder"
    if auth.is_admin:
        return "admin"
    return "caregiver"
