"""Pydantic request validation schemas.

Port of validators/schemas.js (Zod) → Pydantic models.
FastAPI automatically validates request bodies against these.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator


# ---------------------------------------------------------------------------
# Common validators
# ---------------------------------------------------------------------------

def normalize_phone(phone: str) -> str:
    """Normalize phone to E.164-ish format."""
    digits = re.sub(r"\D", "", phone)
    if len(digits) == 10:
        return f"+1{digits}"
    return f"+{digits}"


MEMORY_TYPES = (
    "fact", "preference", "event", "relationship",
    "family", "interest", "routine",
)

REMINDER_TYPES = ("custom", "social")


# ---------------------------------------------------------------------------
# Senior schemas
# ---------------------------------------------------------------------------

class CreateSeniorRequest(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    phone: str = Field(min_length=10, max_length=20)
    timezone: str = "America/New_York"
    interests: Optional[list[str]] = None
    family_info: Optional[dict] = None
    preferred_call_times: Optional[dict] = None
    is_active: bool = True

    @field_validator("phone")
    @classmethod
    def validate_phone(cls, v: str) -> str:
        if not re.match(r"^[\d+\-\s()]+$", v):
            raise ValueError("Phone number contains invalid characters")
        return normalize_phone(v)


class UpdateSeniorRequest(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=255)
    phone: Optional[str] = Field(default=None, min_length=10, max_length=20)
    timezone: Optional[str] = None
    interests: Optional[list[str]] = None
    family_info: Optional[dict] = None
    preferred_call_times: Optional[dict] = None
    is_active: Optional[bool] = None

    @field_validator("phone")
    @classmethod
    def validate_phone(cls, v: str | None) -> str | None:
        if v is None:
            return v
        return normalize_phone(v)


# ---------------------------------------------------------------------------
# Memory schemas
# ---------------------------------------------------------------------------

class CreateMemoryRequest(BaseModel):
    type: str = "fact"
    content: str = Field(min_length=1, max_length=5000)
    importance: int = Field(default=50, ge=0, le=100)

    @field_validator("type")
    @classmethod
    def validate_type(cls, v: str) -> str:
        if v not in MEMORY_TYPES:
            raise ValueError(f"Invalid type. Must be one of: {', '.join(MEMORY_TYPES)}")
        return v


# ---------------------------------------------------------------------------
# Reminder schemas
# ---------------------------------------------------------------------------

class CreateReminderRequest(BaseModel):
    senior_id: str
    type: str = "custom"
    title: str = Field(min_length=1, max_length=255)
    description: Optional[str] = Field(default=None, max_length=2000)
    scheduled_time: Optional[datetime] = None
    is_recurring: bool = False
    cron_expression: Optional[str] = None

    @field_validator("type")
    @classmethod
    def validate_type(cls, v: str) -> str:
        if v not in REMINDER_TYPES:
            raise ValueError(f"Invalid type. Must be one of: {', '.join(REMINDER_TYPES)}")
        return v


class UpdateReminderRequest(BaseModel):
    title: Optional[str] = Field(default=None, min_length=1, max_length=255)
    description: Optional[str] = Field(default=None, max_length=2000)
    scheduled_time: Optional[datetime] = None
    is_recurring: Optional[bool] = None
    cron_expression: Optional[str] = None
    is_active: Optional[bool] = None


# ---------------------------------------------------------------------------
# Call schemas
# ---------------------------------------------------------------------------

class InitiateCallRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    senior_id: str = Field(alias="seniorId", min_length=1)


# ---------------------------------------------------------------------------
# Admin auth schemas
# ---------------------------------------------------------------------------

class AdminLoginRequest(BaseModel):
    email: str = Field(min_length=1, max_length=255)
    password: str = Field(min_length=1, max_length=255)
