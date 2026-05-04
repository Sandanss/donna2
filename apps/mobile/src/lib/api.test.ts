import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };

async function loadApi() {
  vi.resetModules();
  vi.doMock("expo-constants", () => ({
    default: {
      expoConfig: {
        extra: {
          apiUrl: "https://api.example.test",
        },
      },
    },
  }));
  return import("./api");
}

describe("mobile API client", () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ success: true, callSid: "call-1" }),
      { status: 200, headers: { "content-type": "application/json" } },
    )));
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.doUnmock("expo-constants");
  });

  it("sanitizes idempotency keys while preserving the scope", async () => {
    const { createIdempotencyKey } = await loadApi();

    const key = createIdempotencyKey("instant call / senior #1");

    expect(key).toMatch(/^instant-call---senior--1:/);
    expect(key.length).toBeLessThanOrEqual(128);
  });

  it("sends auth, request id, idempotency key, and senior body for instant calls", async () => {
    const { api } = await loadApi();

    await expect(
      api.calls.initiate("senior-1", "token-1", { idempotencyKey: "instant-call-key" }),
    ).resolves.toEqual({ success: true, callSid: "call-1" });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://api.example.test/api/call");
    expect(options?.method).toBe("POST");
    expect(options?.headers).toMatchObject({
      Authorization: "Bearer token-1",
      "Content-Type": "application/json",
      "Idempotency-Key": "instant-call-key",
    });
    expect(JSON.parse(String(options?.body))).toEqual({ seniorId: "senior-1" });
    expect((options?.headers as Record<string, string>)["X-Request-Id"]).toBeTruthy();
  });

  it("maps replay conflicts to caregiver-safe messages", async () => {
    const { ApiError, getErrorMessage, isRetryableApiError } = await loadApi();
    const error = new ApiError(
      "Raw backend conflict",
      409,
      { code: "idempotency_key_reused", requestId: "req-1" },
      "conflict",
      "req-1",
    );

    expect(isRetryableApiError(error)).toBe(false);
    expect(getErrorMessage(error, undefined, "call")).toBe(
      "That request changed before Donna finished the first try. Check the latest information, then try again.",
    );
  });

  it("sends caregiver phone and relationship when validating onboarding phone", async () => {
    const { api } = await loadApi();

    await api.onboarding.validatePhone("(555) 123-4567", "token-1", {
      caregiverPhone: "(555) 123-4567",
      relationship: "Myself",
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://api.example.test/api/onboarding/validate-phone");
    expect(options?.method).toBe("POST");
    expect(JSON.parse(String(options?.body))).toEqual({
      phone: "(555) 123-4567",
      caregiverPhone: "(555) 123-4567",
      relation: "Myself",
    });
  });
});
