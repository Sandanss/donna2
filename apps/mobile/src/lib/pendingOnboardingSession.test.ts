import { describe, expect, it, beforeEach } from "vitest";
import {
  clearPendingOnboardingSession,
  hasPendingOnboardingSession,
  markPendingOnboardingSession,
} from "./pendingOnboardingSession";

describe("pending onboarding session marker", () => {
  beforeEach(() => {
    clearPendingOnboardingSession();
  });

  it("defaults to no pending onboarding session", () => {
    expect(hasPendingOnboardingSession()).toBe(false);
  });

  it("tracks and clears the current runtime's create-account onboarding session", () => {
    markPendingOnboardingSession();
    expect(hasPendingOnboardingSession()).toBe(true);

    clearPendingOnboardingSession();
    expect(hasPendingOnboardingSession()).toBe(false);
  });
});
