import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const createAccountSource = fs.readFileSync(
  path.resolve("apps/mobile/app/(auth)/create-account.tsx"),
  "utf-8",
);
const signInSource = fs.readFileSync(
  path.resolve("apps/mobile/app/(auth)/sign-in.tsx"),
  "utf-8",
);
const onboardingStep1Source = fs.readFileSync(
  path.resolve("apps/mobile/app/(onboarding)/step1.tsx"),
  "utf-8",
);
const onboardingStoreSource = fs.readFileSync(
  path.resolve("apps/mobile/src/stores/onboarding.ts"),
  "utf-8",
);
const authCreateAccountFlowSource = fs.readFileSync(
  path.resolve("apps/mobile/.maestro/manual/auth_create_account.yaml"),
  "utf-8",
);
const rootLayoutSource = fs.readFileSync(
  path.resolve("apps/mobile/app/_layout.tsx"),
  "utf-8",
);
const profileSessionSource = fs.readFileSync(
  path.resolve("apps/mobile/src/lib/profileSession.ts"),
  "utf-8",
);

function getProfileQueryKey(userId) {
  return ["profile", userId ?? "anonymous"];
}

function resolvePostAuthRoute({ profile, error }) {
  if ((profile?.seniors?.length ?? 0) > 0) {
    return "/(tabs)";
  }

  if (error?.needsOnboarding === true) {
    return "/(onboarding)/step1";
  }

  if (profile) {
    return "/(onboarding)/step1";
  }

  return null;
}

describe("mobile auth routing", () => {
  it("scopes the profile query cache by Clerk user", () => {
    expect(profileSessionSource).toContain("getProfileQueryKey");
    expect(profileSessionSource).toContain('userId ?? "anonymous"');
    expect(getProfileQueryKey("user_123")).toEqual(["profile", "user_123"]);
    expect(getProfileQueryKey()).toEqual(["profile", "anonymous"]);
  });

  it("routes completed caregivers to tabs", () => {
    expect(profileSessionSource).toContain('return "/(tabs)"');
    expect(
      resolvePostAuthRoute({
        profile: { seniors: [{ id: "senior_1" }] },
      }),
    ).toBe("/(tabs)");
  });

  it("routes onboarding-needed 404s to the onboarding flow", () => {
    expect(profileSessionSource).toContain("needsOnboarding === true");
    const error = { needsOnboarding: true };
    expect(resolvePostAuthRoute({ error })).toBe("/(onboarding)/step1");
  });

  it("does not misroute generic server failures as onboarding", () => {
    const error = { message: "Internal server error", requestId: "req_123" };
    expect(resolvePostAuthRoute({ error })).toBeNull();
  });

  it("keeps auth screens from treating every profile failure as onboarding", () => {
    expect(createAccountSource).toContain("resolvePostAuthRoute");
    expect(createAccountSource).not.toContain(
      "} catch {\n      router.replace(\"/(onboarding)/step1\" as any);",
    );
    expect(signInSource).toContain("resolvePostAuthRoute");
    expect(signInSource).not.toContain(
      "} catch {\n      router.replace(\"/(onboarding)/step1\" as any);",
    );
  });

  it("keeps Apple signup social-first and makes email signup opt-in on iOS", () => {
    expect(createAccountSource).toContain(
      'useState(Platform.OS !== "ios")',
    );
    expect(createAccountSource).toContain("!showEmailForm ?");
    expect(createAccountSource).toContain('title={t("auth.continueWithApple")}');
    expect(createAccountSource).toContain('title={t("auth.continueWithEmail")}');
    expect(createAccountSource).toContain('testID="create-account-show-email"');

    expect(createAccountSource.indexOf("!showEmailForm ?")).toBeLessThan(
      createAccountSource.indexOf('testID="create-account-email"'),
    );
  });

  it("keeps caregiver onboarding from asking for email after Clerk signup", () => {
    expect(onboardingStep1Source).not.toContain('testID="input-email"');
    expect(onboardingStep1Source).not.toContain('setField("email"');
    expect(onboardingStep1Source).not.toContain("emailRequired");
    expect(onboardingStoreSource).not.toMatch(/\bemail:\s*string\b/);
    expect(onboardingStoreSource).not.toContain("email: state.email");
  });

  it("routes Apple account creation through caregiver phone and location before senior setup", () => {
    expect(createAccountSource).not.toContain(
      'provider === "apple" ? "/(onboarding)/step2"',
    );
    expect(signInSource).not.toContain(
      'provider === "apple" ? "/(onboarding)/step2"',
    );
    expect(onboardingStep1Source).not.toContain(
      'router.replace("/(onboarding)/step2" as any)',
    );
    expect(onboardingStep1Source).toContain('"onboarding.step1.appleTitle"');
    expect(onboardingStep1Source).toContain("onboarding.step1.phoneRequired");
    expect(onboardingStep1Source).toContain("onboarding.step1.cityRequired");
    expect(onboardingStep1Source).toContain("onboarding.step1.stateRequired");
    expect(onboardingStep1Source).toContain("onboarding.step1.zipRequired");
    expect(onboardingStep1Source).toContain('testID="input-caregiver-city"');
  });

  it("keeps email/password Maestro setup on the explicit email fallback", () => {
    expect(authCreateAccountFlowSource).toContain('id: "create-account-show-email"');
    expect(authCreateAccountFlowSource.indexOf('id: "create-account-show-email"')).toBeLessThan(
      authCreateAccountFlowSource.indexOf('id: "create-account-email"'),
    );
  });

  it("shows a retry state instead of forcing tabs on unknown bootstrap errors", () => {
    expect(rootLayoutSource).toContain("showBootstrapError");
    expect(rootLayoutSource).toContain("We couldn't load your Donna profile");
    expect(rootLayoutSource).not.toContain("router.replace(\"/(tabs)\")");
  });
});
