"""Redis client for multi-instance shared state.

Uses Redis protocol when REDIS_URL is set, uses Upstash REST when
UPSTASH_REDIS_REST_URL/TOKEN are set, and falls back to in-memory dicts for
single-instance deployments.

Usage:
    from lib.redis_client import shared_state

    # Dict-like interface (works with or without Redis)
    await shared_state.set("call_metadata:CA123", {...}, ttl=1800)
    data = await shared_state.get("call_metadata:CA123")
    await shared_state.delete("call_metadata:CA123")
"""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any

from loguru import logger


class InMemoryState:
    """In-memory fallback when Redis is not configured."""

    is_shared = False

    def __init__(self):
        self._data: dict[str, Any] = {}
        self._expiry: dict[str, float] = {}

    async def set(self, key: str, value: Any, ttl: int | None = None) -> None:
        self._data[key] = value
        if ttl:
            self._expiry[key] = time.time() + ttl

    async def set_if_absent(self, key: str, value: Any, ttl: int | None = None) -> bool:
        self._cleanup_expired()
        if key in self._data:
            return False
        await self.set(key, value, ttl=ttl)
        return True

    async def get(self, key: str) -> Any | None:
        if key in self._expiry and time.time() > self._expiry[key]:
            self._data.pop(key, None)
            self._expiry.pop(key, None)
            return None
        return self._data.get(key)

    async def delete(self, key: str) -> None:
        self._data.pop(key, None)
        self._expiry.pop(key, None)

    async def keys(self, pattern: str = "*") -> list[str]:
        """Return keys matching a simple prefix pattern (prefix*)."""
        self._cleanup_expired()
        if pattern == "*":
            return list(self._data.keys())
        prefix = pattern.rstrip("*")
        return [k for k in self._data if k.startswith(prefix)]

    async def set_hash(self, key: str, mapping: dict, ttl: int | None = None) -> None:
        existing = self._data.get(key, {})
        if isinstance(existing, dict):
            existing.update(mapping)
            self._data[key] = existing
        else:
            self._data[key] = mapping
        if ttl:
            self._expiry[key] = time.time() + ttl

    async def get_hash(self, key: str) -> dict | None:
        if key in self._expiry and time.time() > self._expiry[key]:
            self._data.pop(key, None)
            self._expiry.pop(key, None)
            return None
        val = self._data.get(key)
        return val if isinstance(val, dict) else None

    async def delete_hash_field(self, key: str, field: str) -> None:
        val = self._data.get(key)
        if isinstance(val, dict):
            val.pop(field, None)

    async def cleanup(self) -> int:
        """Remove expired entries. Returns count removed."""
        return self._cleanup_expired()

    def _cleanup_expired(self) -> int:
        now = time.time()
        expired = [k for k, exp in self._expiry.items() if now > exp]
        for k in expired:
            self._data.pop(k, None)
            self._expiry.pop(k, None)
        return len(expired)

    async def close(self) -> None:
        pass


class RedisState:
    """Redis-backed shared state for multi-instance deployments."""

    is_shared = True

    def __init__(self, url: str):
        self._url = url
        self._redis = None

    async def _get_client(self):
        if self._redis is None:
            import redis.asyncio as aioredis
            self._redis = aioredis.from_url(
                self._url,
                decode_responses=True,
                max_connections=20,
            )
            logger.info("Redis connected: {}", self._url.split("@")[-1] if "@" in self._url else "localhost")
        return self._redis

    async def set(self, key: str, value: Any, ttl: int | None = None) -> None:
        r = await self._get_client()
        serialized = json.dumps(value, default=str)
        if ttl:
            await r.setex(key, ttl, serialized)
        else:
            await r.set(key, serialized)

    async def set_if_absent(self, key: str, value: Any, ttl: int | None = None) -> bool:
        r = await self._get_client()
        serialized = json.dumps(value, default=str)
        return bool(await r.set(key, serialized, ex=ttl, nx=True))

    async def get(self, key: str) -> Any | None:
        r = await self._get_client()
        val = await r.get(key)
        if val is None:
            return None
        try:
            return json.loads(val)
        except (json.JSONDecodeError, TypeError):
            return val

    async def delete(self, key: str) -> None:
        r = await self._get_client()
        await r.delete(key)

    async def keys(self, pattern: str = "*") -> list[str]:
        r = await self._get_client()
        return [k async for k in r.scan_iter(match=pattern, count=100)]

    async def set_hash(self, key: str, mapping: dict, ttl: int | None = None) -> None:
        r = await self._get_client()
        # Serialize values for Redis hash
        serialized = {k: json.dumps(v, default=str) for k, v in mapping.items()}
        await r.hset(key, mapping=serialized)
        if ttl:
            await r.expire(key, ttl)

    async def get_hash(self, key: str) -> dict | None:
        r = await self._get_client()
        val = await r.hgetall(key)
        if not val:
            return None
        return {k: json.loads(v) for k, v in val.items()}

    async def delete_hash_field(self, key: str, field: str) -> None:
        r = await self._get_client()
        await r.hdel(key, field)

    async def cleanup(self) -> int:
        """Redis handles TTL expiry automatically. Returns 0."""
        return 0

    async def close(self) -> None:
        if self._redis:
            await self._redis.close()
            self._redis = None


class UpstashRestState:
    """Upstash REST-backed shared state for multi-instance deployments."""

    RETRY_AFTER_SECONDS = 60

    def __init__(self, url: str, token: str):
        url = url.strip()
        if url and "://" not in url:
            url = f"https://{url}"
        self._url = url.rstrip("/")
        self._token = token
        self._client = None
        self._disabled_until = 0.0

    @property
    def is_shared(self) -> bool:
        return time.monotonic() >= self._disabled_until

    async def _get_client(self):
        if self._client is None:
            import httpx
            self._client = httpx.AsyncClient(
                base_url=self._url,
                headers={"Authorization": f"Bearer {self._token}"},
                timeout=5.0,
            )
            display_url = self._url.removeprefix("https://").removeprefix("http://")
            logger.info("Upstash Redis REST connected: {}", display_url)
        return self._client

    async def _command(self, *parts: Any) -> Any:
        if not self.is_shared:
            raise RuntimeError("Upstash Redis REST is temporarily unavailable")
        import httpx

        client = await self._get_client()
        try:
            response = await client.post("/", json=list(parts))
            response.raise_for_status()
        except httpx.HTTPError as exc:
            self._disabled_until = time.monotonic() + self.RETRY_AFTER_SECONDS
            logger.warning(
                "Upstash Redis REST unavailable; using local state until retry: {err}",
                err=str(exc),
            )
            raise
        payload = response.json()
        if isinstance(payload, dict) and "error" in payload and payload["error"]:
            raise RuntimeError(payload["error"])
        return payload.get("result") if isinstance(payload, dict) else payload

    async def set(self, key: str, value: Any, ttl: int | None = None) -> None:
        serialized = json.dumps(value, default=str)
        if ttl:
            await self._command("SET", key, serialized, "EX", ttl)
        else:
            await self._command("SET", key, serialized)

    async def set_if_absent(self, key: str, value: Any, ttl: int | None = None) -> bool:
        serialized = json.dumps(value, default=str)
        if ttl:
            result = await self._command("SET", key, serialized, "EX", ttl, "NX")
        else:
            result = await self._command("SET", key, serialized, "NX")
        return bool(result)

    async def get(self, key: str) -> Any | None:
        val = await self._command("GET", key)
        if val is None:
            return None
        try:
            return json.loads(val)
        except (json.JSONDecodeError, TypeError):
            return val

    async def delete(self, key: str) -> None:
        await self._command("DEL", key)

    async def keys(self, pattern: str = "*") -> list[str]:
        cursor = "0"
        keys: list[str] = []
        while True:
            result = await self._command("SCAN", cursor, "MATCH", pattern, "COUNT", 100)
            if not isinstance(result, list) or len(result) != 2:
                return keys
            cursor = str(result[0])
            keys.extend(result[1] or [])
            if cursor == "0":
                return keys

    async def set_hash(self, key: str, mapping: dict, ttl: int | None = None) -> None:
        serialized: list[Any] = []
        for field, value in mapping.items():
            serialized.extend([field, json.dumps(value, default=str)])
        if serialized:
            await self._command("HSET", key, *serialized)
        if ttl:
            await self._command("EXPIRE", key, ttl)

    async def get_hash(self, key: str) -> dict | None:
        val = await self._command("HGETALL", key)
        if not val:
            return None
        if isinstance(val, dict):
            items = val.items()
        elif isinstance(val, list):
            items = zip(val[0::2], val[1::2])
        else:
            return None
        return {k: json.loads(v) for k, v in items}

    async def delete_hash_field(self, key: str, field: str) -> None:
        await self._command("HDEL", key, field)

    async def cleanup(self) -> int:
        """Upstash handles TTL expiry automatically. Returns 0."""
        return 0

    async def close(self) -> None:
        if self._client:
            await self._client.aclose()
            self._client = None


def create_shared_state(
    redis_url: str = "",
    upstash_url: str = "",
    upstash_token: str = "",
) -> InMemoryState | RedisState | UpstashRestState:
    """Create shared state backend based on configuration."""
    if redis_url:
        logger.info("Using Redis for shared state")
        return RedisState(redis_url)
    elif upstash_url and upstash_token:
        logger.info("Using Upstash Redis REST for shared state")
        return UpstashRestState(upstash_url, upstash_token)
    else:
        logger.info("Using in-memory shared state (single instance)")
        return InMemoryState()


# Module-level singleton — lazy init
_state: InMemoryState | RedisState | UpstashRestState | None = None


def get_shared_state() -> InMemoryState | RedisState | UpstashRestState:
    """Get or create the shared state singleton."""
    global _state
    if _state is None:
        import os
        redis_url = os.getenv("REDIS_URL", "")
        upstash_url = os.getenv("UPSTASH_REDIS_REST_URL", "")
        upstash_token = os.getenv("UPSTASH_REDIS_REST_TOKEN", "")
        _state = create_shared_state(redis_url, upstash_url, upstash_token)
    return _state
