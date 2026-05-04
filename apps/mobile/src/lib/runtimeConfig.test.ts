import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };

async function loadRuntimeConfig(extra: Record<string, unknown> = {}) {
  vi.resetModules();
  vi.doMock("expo-constants", () => ({
    default: {
      expoConfig: { extra },
    },
  }));
  return import("./runtimeConfig");
}

describe("runtime config", () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
    vi.doUnmock("expo-constants");
  });

  it("prefers app extra config and trims trailing API slashes", async () => {
    const config = await loadRuntimeConfig({
      apiUrl: " https://api.example.test/// ",
      clerkPublishableKey: " pk_test_example ",
      sentryDsn: " https://sentry.example.test ",
      eas: { projectId: "project-1" },
    });

    expect(config.getApiUrl()).toBe("https://api.example.test");
    expect(config.getClerkPublishableKey()).toBe("pk_test_example");
    expect(config.getSentryDsn()).toBe("https://sentry.example.test");
    expect(config.getEasProjectId()).toBe("project-1");
  });

  it("falls back to EXPO_PUBLIC env values", async () => {
    process.env.EXPO_PUBLIC_API_URL = "https://env-api.example.test/";
    process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_env";

    const config = await loadRuntimeConfig();

    expect(config.getApiUrl()).toBe("https://env-api.example.test");
    expect(config.getClerkPublishableKey()).toBe("pk_test_env");
  });

  it("throws clearly when required public config is absent", async () => {
    delete process.env.EXPO_PUBLIC_API_URL;
    delete process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;

    const config = await loadRuntimeConfig();

    expect(() => config.getApiUrl()).toThrow("EXPO_PUBLIC_API_URL is required");
    expect(() => config.getClerkPublishableKey()).toThrow(
      "EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY is required",
    );
  });
});
