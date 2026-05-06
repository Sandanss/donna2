"""Data retention routes — hard deletion of senior/prospect data.

DELETE /api/seniors/{senior_id}/data — hard-delete a senior and all associated data
DELETE /api/prospects/{prospect_id}/data — hard-delete a prospect and all associated data
"""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from loguru import logger

from api.middleware.auth import require_auth, require_admin, AuthContext
from api.middleware.rate_limit import limiter, WRITE_LIMIT
from services.caregivers import can_access_senior
from services.hard_delete import hard_delete_senior, hard_delete_prospect
from services.seniors import get_by_id

router = APIRouter()


@router.delete("/api/seniors/{senior_id}/data")
@limiter.limit(WRITE_LIMIT)
async def delete_senior_data(
    request: Request,
    senior_id: UUID,
    auth: AuthContext = Depends(require_auth),
):
    """Hard-delete a senior and all associated data.

    Accessible by:
    - Admins (via JWT or cofounder key)
    - Caregivers (via Clerk JWT) who have access to the senior
    """
    sid = str(senior_id)

    # Authorization check
    if not auth.is_admin:
        if not auth.clerk_user_id:
            raise HTTPException(status_code=403, detail="Access denied")
        has_access = await can_access_senior(auth.clerk_user_id, sid)
        if not has_access:
            raise HTTPException(status_code=403, detail="Access denied to this senior")

    # Verify senior exists
    senior = await get_by_id(sid)
    if not senior:
        raise HTTPException(status_code=404, detail="Senior not found")

    deleted_by = auth.clerk_user_id or auth.user_id or "unknown"
    reason = "caregiver_request" if auth.clerk_user_id and not auth.is_admin else "admin_request"

    logger.info(
        "Hard-delete requested for senior {sid} by {by}",
        sid=sid[:8],
        by=str(deleted_by)[:8],
    )

    try:
        counts = await hard_delete_senior(sid, deleted_by, reason)
    except RuntimeError as exc:
        if "legal hold" in str(exc).lower():
            raise HTTPException(status_code=423, detail=str(exc)) from exc
        raise
    return {"success": True, "deleted_counts": counts}


@router.delete("/api/prospects/{prospect_id}/data")
@limiter.limit(WRITE_LIMIT)
async def delete_prospect_data(
    request: Request,
    prospect_id: UUID,
    auth: AuthContext = Depends(require_admin),
):
    """Hard-delete a prospect and all associated data. Admin only."""
    pid = str(prospect_id)
    deleted_by = auth.user_id or "unknown"

    logger.info(
        "Hard-delete requested for prospect {pid} by {by}",
        pid=pid[:8],
        by=str(deleted_by)[:8],
    )

    try:
        counts = await hard_delete_prospect(pid, deleted_by, "admin_request")
    except RuntimeError as exc:
        if "legal hold" in str(exc).lower():
            raise HTTPException(status_code=423, detail=str(exc)) from exc
        raise
    return {"success": True, "deleted_counts": counts}
