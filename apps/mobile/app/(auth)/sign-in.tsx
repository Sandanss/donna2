import { useAuth, useOAuth, useSignIn, useSignUp } from "@clerk/clerk-expo";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useRef, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { useTranslation } from "react-i18next";
import { SafeAreaView } from "react-native-safe-area-context";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/src/components/ui/Button";
import { Input } from "@/src/components/ui/Input";
import { COLORS } from "@/src/constants/theme";
import { api, getErrorMessage } from "@/src/lib/api";
import { startAppleAuthenticationWithoutProfileScopes } from "@/src/lib/appleAuth";
import { getClerkErrorMessage, getClerkFieldErrors } from "@/src/lib/clerkErrors";
import {
  clearPendingOnboardingSession,
  markPendingOnboardingSession,
} from "@/src/lib/pendingOnboardingSession";
import { resolvePostAuthRoute } from "@/src/lib/profileSession";
import { clearOnboardingDraft, useOnboardingStore } from "@/src/stores/onboarding";

WebBrowser.maybeCompleteAuthSession();

type AuthFactor = {
  strategy: string;
  safeIdentifier?: string;
  emailAddressId?: string;
  phoneNumberId?: string;
  channel?: string;
};

type AuthStep =
  | { type: "credentials" }
  | { type: "forgot_password_code"; factor: AuthFactor }
  | { type: "forgot_password_new_password" }
  | { type: "choose_second_factor"; factors: AuthFactor[] }
  | { type: "second_factor_code"; factor: AuthFactor };

const SECOND_FACTOR_CODE_STRATEGIES = new Set([
  "email_code",
  "phone_code",
  "totp",
  "backup_code",
]);

const RESET_PASSWORD_CODE_STRATEGIES = new Set([
  "reset_password_email_code",
  "reset_password_phone_code",
]);

function getFactorLabel(factor: AuthFactor, t: (key: string, opts?: any) => string): string {
  switch (factor.strategy) {
    case "email_code":
      return factor.safeIdentifier
        ? t("auth.factorLabels.emailCode", { identifier: factor.safeIdentifier })
        : t("auth.factorLabels.emailCodeGeneric");
    case "phone_code":
      return factor.safeIdentifier
        ? t("auth.factorLabels.phoneCode", { identifier: factor.safeIdentifier })
        : t("auth.factorLabels.phoneCodeGeneric");
    case "totp":
      return t("auth.factorLabels.totp");
    case "backup_code":
      return t("auth.factorLabels.backupCode");
    case "reset_password_email_code":
      return factor.safeIdentifier
        ? t("auth.factorLabels.resetEmailCode", { identifier: factor.safeIdentifier })
        : t("auth.factorLabels.resetEmailCodeGeneric");
    case "reset_password_phone_code":
      return factor.safeIdentifier
        ? t("auth.factorLabels.resetPhoneCode", { identifier: factor.safeIdentifier })
        : t("auth.factorLabels.resetPhoneCodeGeneric");
    default:
      return t("auth.factorLabels.generic");
  }
}

function getCodeInputLabel(factor: AuthFactor, t: (key: string) => string): string {
  switch (factor.strategy) {
    case "backup_code":
      return t("auth.codeInputLabels.backupCode");
    case "totp":
      return t("auth.codeInputLabels.totp");
    default:
      return t("auth.codeInputLabels.default");
  }
}

function isNumericCodeFactor(factor: AuthFactor): boolean {
  return factor.strategy !== "backup_code";
}

function canResendFactorCode(factor: AuthFactor): boolean {
  return (
    factor.strategy === "email_code" ||
    factor.strategy === "phone_code" ||
    factor.strategy === "reset_password_email_code" ||
    factor.strategy === "reset_password_phone_code"
  );
}

export default function SignInScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { signIn, setActive, isLoaded } = useSignIn();
  const { getToken, signOut } = useAuth();
  const queryClient = useQueryClient();
  const { startOAuthFlow: startGoogleOAuth } = useOAuth({
    strategy: "oauth_google",
  });
  const { signUp: appleSignUp, isLoaded: isSignUpLoaded } = useSignUp();

  const [authStep, setAuthStep] = useState<AuthStep>({ type: "credentials" });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [verificationError, setVerificationError] = useState<string>();
  const [resetPasswordError, setResetPasswordError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [oauthLoading, setOauthLoading] = useState<
    "google" | "apple" | null
  >(null);
  const [errors, setErrors] = useState<{ email?: string; password?: string }>(
    {}
  );
  const [secondFactorOptions, setSecondFactorOptions] = useState<AuthFactor[]>(
    []
  );
  const [resetPasswordFactor, setResetPasswordFactor] =
    useState<AuthFactor | null>(null);
  const passwordRef = useRef<TextInput>(null);

  function onboardingStartRoute(provider?: "google" | "apple") {
    return provider === "apple" ? "/(onboarding)/step2" : "/(onboarding)/step1";
  }

  async function navigateAfterAuth({
    allowOnboarding = false,
    provider,
  }: {
    allowOnboarding?: boolean;
    provider?: "google" | "apple";
  } = {}) {
    const token = await getToken();
    if (!token) {
      Alert.alert("Sign In Complete", "Please sign in again to continue.");
      return;
    }

    try {
      const nextRoute = resolvePostAuthRoute({
        profile: await api.caregivers.me(token),
      });
      if (nextRoute) {
        router.replace(
          nextRoute === "/(onboarding)/step1"
            ? (onboardingStartRoute(provider) as any)
            : (nextRoute as any),
        );
        return;
      }
    } catch (error) {
      const nextRoute = resolvePostAuthRoute({ error });
      if (nextRoute) {
        if (allowOnboarding) {
          router.replace(
            nextRoute === "/(onboarding)/step1"
              ? (onboardingStartRoute(provider) as any)
              : (nextRoute as any),
          );
          return;
        }

        clearPendingOnboardingSession();
        try {
          await api.account.cancelIncompleteOnboarding(token);
        } catch {
          // Local sign-out still prevents an incomplete account from trapping the user.
        } finally {
          try {
            await clearOnboardingDraft();
          } catch {
            // Continue; local auth cleanup is more important than draft cleanup.
          }
          queryClient.removeQueries({ queryKey: ["profile"] });
          try {
            await signOut();
          } catch {
            // The Clerk user may already be gone server-side.
          }
        }
        Alert.alert(
          "No Donna profile found",
          "We cleared the incomplete account for this sign-in. Create a new account to start setup again.",
        );
        router.replace("/");
        return;
      }
      Alert.alert(
        "Sign In Complete",
        getErrorMessage(
          error,
          "We signed you in, but couldn't load your Donna profile right now. Please try again in a moment.",
          "auth",
        ),
      );
      return;
    }

    router.replace(onboardingStartRoute(provider) as any);
  }

  function clearVerificationUi() {
    setVerificationCode("");
    setVerificationError(undefined);
  }

  function clearResetPasswordUi() {
    setNewPassword("");
    setConfirmNewPassword("");
    setResetPasswordError(undefined);
  }

  function resetToCredentials() {
    setAuthStep({ type: "credentials" });
    clearVerificationUi();
    clearResetPasswordUi();
    setSecondFactorOptions([]);
    setResetPasswordFactor(null);
  }

  function handleBack() {
    switch (authStep.type) {
      case "credentials":
        router.back();
        return;
      case "forgot_password_code":
        resetToCredentials();
        return;
      case "forgot_password_new_password":
        clearResetPasswordUi();
        clearVerificationUi();
        if (resetPasswordFactor) {
          setAuthStep({
            type: "forgot_password_code",
            factor: resetPasswordFactor,
          });
        } else {
          resetToCredentials();
        }
        return;
      case "choose_second_factor":
        resetToCredentials();
        return;
      case "second_factor_code":
        clearVerificationUi();
        if (secondFactorOptions.length > 1) {
          setAuthStep({
            type: "choose_second_factor",
            factors: secondFactorOptions,
          });
        } else {
          resetToCredentials();
        }
        return;
    }
  }

  async function finishSession(createdSessionId?: string | null) {
    if (!createdSessionId) {
      throw new Error("Missing session after verification");
    }
    if (!setActive) {
      throw new Error("Clerk session activation is not available yet");
    }

    await setActive({ session: createdSessionId });
    await navigateAfterAuth();
  }

  function getSupportedSecondFactorOptions(resource: any): AuthFactor[] {
    return ((resource?.supportedSecondFactors as AuthFactor[] | undefined) || [])
      .filter((factor) => SECOND_FACTOR_CODE_STRATEGIES.has(factor.strategy));
  }

  function getSupportedFirstFactorStrategies(resource: any): string[] {
    return ((resource?.supportedFirstFactors as Array<{ strategy?: string }> | undefined) || [])
      .map((factor) => factor.strategy)
      .filter((strategy): strategy is string => Boolean(strategy));
  }

  function getSupportedResetPasswordFactors(resource: any): AuthFactor[] {
    return ((resource?.supportedFirstFactors as AuthFactor[] | undefined) || [])
      .filter((factor) => RESET_PASSWORD_CODE_STRATEGIES.has(factor.strategy));
  }

  async function prepareSecondFactorCode(factor: AuthFactor) {
    if (!isLoaded) return;

    setAuthStep({ type: "second_factor_code", factor });
    setVerificationCode("");
    setLoading(true);
    setVerificationError(undefined);

    try {
      if (factor.strategy === "email_code") {
        await signIn.prepareSecondFactor({
          strategy: factor.strategy as any,
          ...(factor.emailAddressId
            ? { emailAddressId: factor.emailAddressId }
            : {}),
        } as any);
      } else if (factor.strategy === "phone_code") {
        await signIn.prepareSecondFactor({
          strategy: factor.strategy as any,
          ...(factor.phoneNumberId
            ? { phoneNumberId: factor.phoneNumberId }
            : {}),
        } as any);
      }
    } catch (err: unknown) {
      setVerificationError(
        getClerkErrorMessage(err, t("auth.couldNotPrepare"))
      );
    } finally {
      setLoading(false);
    }
  }

  async function routeToSecondFactor(resource: any) {
    const factors = getSupportedSecondFactorOptions(resource);

    if (factors.length === 0) {
      throw new Error(
        "This account requires a second-factor method that the app does not support yet."
      );
    }

    setSecondFactorOptions(factors);
    clearVerificationUi();

    if (factors.length === 1) {
      await prepareSecondFactorCode(factors[0]);
      return;
    }

    setAuthStep({ type: "choose_second_factor", factors });
  }

  async function handleSignInResult(result: any) {
    switch (result?.status) {
      case "complete":
        await finishSession(result.createdSessionId);
        return;
      case "needs_first_factor": {
        const supportedFirstFactors = getSupportedFirstFactorStrategies(result);

        if (password && signIn && supportedFirstFactors.includes("password")) {
          const attemptedPassword = await signIn.attemptFirstFactor({
            strategy: "password",
            password,
          } as any);

          if (attemptedPassword?.status !== "needs_first_factor") {
            await handleSignInResult(attemptedPassword);
            return;
          }
        }

        throw new Error(
          `The sign-in flow still needs a first-factor step the mobile app does not support yet (supported: ${supportedFirstFactors.join(", ") || "none"}).`
        );
      }
      case "needs_second_factor":
        await routeToSecondFactor(result);
        return;
      case "needs_new_password":
        clearResetPasswordUi();
        setAuthStep({ type: "forgot_password_new_password" });
        return;
      default:
        throw new Error(
          `The sign-in flow needs an unsupported verification step (${result?.status ?? "missing"}).`
        );
    }
  }

  async function handleSignIn() {
    const nextErrors: { email?: string; password?: string } = {};

    if (!email.trim()) nextErrors.email = t("auth.emailRequired");
    if (!password) nextErrors.password = t("auth.passwordRequired");

    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    if (!isLoaded) return;

    setLoading(true);

    try {
      const result = await signIn.create({
        strategy: "password",
        identifier: email.trim(),
        password,
      });
      await handleSignInResult(result);
    } catch (err: unknown) {
      const clerkFieldErrors = getClerkFieldErrors(err);
      const nextFieldErrors = {
        email: clerkFieldErrors.identifier || clerkFieldErrors.emailAddress,
        password: clerkFieldErrors.password,
      };

      if (nextFieldErrors.email || nextFieldErrors.password) {
        setErrors((current) => ({
          ...current,
          ...nextFieldErrors,
        }));
      } else {
        Alert.alert(
          t("auth.signInFailed"),
          getClerkErrorMessage(err, t("auth.couldNotSignIn"))
        );
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleForgotPassword() {
    if (!email.trim()) {
      Alert.alert(
        t("auth.enterEmailFirst"),
        t("auth.enterEmailFirstDescription")
      );
      return;
    }

    if (!isLoaded) return;
    setLoading(true);

    try {
      const result = await signIn.create({
        strategy: "reset_password_email_code",
        identifier: email.trim(),
      });

      const factor = getSupportedResetPasswordFactors(result)[0];

      if (!factor) {
        throw new Error(
          "Password reset is not configured for this account in a code-based flow."
        );
      }

      setResetPasswordFactor(factor);
      clearVerificationUi();
      clearResetPasswordUi();

      await signIn.prepareFirstFactor({
        strategy: factor.strategy as any,
        ...(factor.emailAddressId
          ? { emailAddressId: factor.emailAddressId }
          : {}),
        ...(factor.phoneNumberId
          ? { phoneNumberId: factor.phoneNumberId }
          : {}),
      } as any);

      setAuthStep({ type: "forgot_password_code", factor });
    } catch (err: unknown) {
      Alert.alert(
        t("auth.passwordResetFailed"),
        getClerkErrorMessage(err, t("auth.couldNotSendReset"))
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleForgotPasswordCodeSubmit() {
    if (authStep.type !== "forgot_password_code" || !isLoaded) return;

    const normalizedCode = verificationCode.replace(/\s+/g, "");
    if (!normalizedCode) {
      setVerificationError(t("auth.verificationRequired"));
      return;
    }

    setLoading(true);
    setVerificationError(undefined);

    try {
      const result = await signIn.attemptFirstFactor({
        strategy: authStep.factor.strategy as any,
        code: normalizedCode,
      } as any);

      await handleSignInResult(result);
    } catch (err: unknown) {
      setVerificationError(
        getClerkErrorMessage(err, t("auth.couldNotVerify"))
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleResetPasswordSubmit() {
    if (!isLoaded) return;

    if (!newPassword) {
      setResetPasswordError(t("auth.passwordRequired"));
      return;
    }

    if (newPassword.length < 8) {
      setResetPasswordError(t("auth.passwordTooShort", { count: 8 }));
      return;
    }

    if (newPassword !== confirmNewPassword) {
      setResetPasswordError(t("auth.passwordsDoNotMatch"));
      return;
    }

    setLoading(true);
    setResetPasswordError(undefined);

    try {
      const result = await signIn.resetPassword({
        password: newPassword,
        signOutOfOtherSessions: true,
      });

      await handleSignInResult(result);
    } catch (err: unknown) {
      setResetPasswordError(
        getClerkErrorMessage(err, t("auth.couldNotUpdatePassword"))
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleSecondFactorSubmit() {
    if (authStep.type !== "second_factor_code" || !isLoaded) return;

    const normalizedCode = verificationCode.replace(/\s+/g, "");
    if (!normalizedCode) {
      setVerificationError(t("auth.verificationRequired"));
      return;
    }

    setLoading(true);
    setVerificationError(undefined);

    try {
      const result = await signIn.attemptSecondFactor({
        strategy: authStep.factor.strategy as any,
        code: normalizedCode,
      } as any);

      await handleSignInResult(result);
    } catch (err: unknown) {
      setVerificationError(
        getClerkErrorMessage(err, t("auth.couldNotVerify"))
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleResendCurrentCode() {
    if (!isLoaded) return;

    setLoading(true);
    setVerificationError(undefined);

    try {
      if (authStep.type === "forgot_password_code") {
        await signIn.prepareFirstFactor({
          strategy: authStep.factor.strategy as any,
          ...(authStep.factor.emailAddressId
            ? { emailAddressId: authStep.factor.emailAddressId }
            : {}),
          ...(authStep.factor.phoneNumberId
            ? { phoneNumberId: authStep.factor.phoneNumberId }
            : {}),
        } as any);
      } else if (authStep.type === "second_factor_code") {
        await prepareSecondFactorCode(authStep.factor);
        return;
      }
    } catch (err: unknown) {
      setVerificationError(
        getClerkErrorMessage(err, t("auth.couldNotResend"))
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleOAuth(provider: "google" | "apple") {
    setOauthLoading(provider);

    try {
      let result: any;

      if (provider === "apple") {
        if (Platform.OS !== "ios") return;
        result = await startAppleAuthenticationWithoutProfileScopes({
          signIn,
          signUp: appleSignUp,
          setActive,
          isSignInLoaded: isLoaded,
          isSignUpLoaded,
        });
      } else {
        result = await startGoogleOAuth();
      }

      // Clerk OAuth may return the session ID at top level, or nested inside
      // signIn/signUp when the flow involves account transfer or creation.
      const sessionId =
        result.createdSessionId ??
        (result.signIn as any)?.createdSessionId ??
        (result.signUp as any)?.createdSessionId;
      const activateFn = result.setActive;
      const createdViaOAuthSignUp = Boolean(
        (result.signUp as any)?.createdSessionId,
      );

      if (sessionId && activateFn) {
        if (createdViaOAuthSignUp) {
          useOnboardingStore.getState().setField("authProvider", provider);
          markPendingOnboardingSession();
        }
        await activateFn({ session: sessionId });
        await navigateAfterAuth({
          allowOnboarding: createdViaOAuthSignUp,
          provider,
        });
        return;
      }

      // Clerk may return "needs_new_password" when an email/password user
      // links an OAuth provider. Skip the password step by resetting it to a
      // random value — the user can always sign in via OAuth going forward.
      const oauthSignIn = result.signIn as any;
      if (oauthSignIn?.status === "needs_new_password") {
        const random = `OAuth_${Date.now()}_${Math.random().toString(36).slice(2)}!`;
        const resetResult = await oauthSignIn.resetPassword({
          password: random,
          signOutOfOtherSessions: false,
        });

        const finalSessionId = resetResult?.createdSessionId;
        if (finalSessionId && result.setActive) {
          await result.setActive({ session: finalSessionId });
          await navigateAfterAuth({ provider });
          return;
        }
      }

      const oauthStatus = oauthSignIn?.status ?? (result.signUp as any)?.status;
      if (oauthStatus) {
        Alert.alert(
          t("auth.oauthError"),
          t("auth.oauthIncomplete"),
        );
      }
    } catch (err: unknown) {
      const message = getClerkErrorMessage(err, "");
      if (message) {
        Alert.alert(
          t("auth.oauthError"),
          message || `${provider} sign in failed`,
        );
      }
    } finally {
      setOauthLoading(null);
    }
  }

  const title = (() => {
    switch (authStep.type) {
      case "credentials":
        return t("auth.welcomeBack");
      case "forgot_password_code":
        return t("auth.checkYourEmail");
      case "forgot_password_new_password":
        return t("auth.setNewPassword");
      case "choose_second_factor":
        return t("auth.chooseSecondFactor");
      case "second_factor_code":
        return getFactorLabel(authStep.factor, t);
    }
  })();

  const subtitle = (() => {
    switch (authStep.type) {
      case "credentials":
        return t("auth.signInSubtitle");
      case "forgot_password_code":
        return `${t("auth.verifyEmailDescription", { email: getFactorLabel(authStep.factor, t).toLowerCase() })}.`;
      case "forgot_password_new_password":
        return t("auth.setNewPasswordSubtitle");
      case "choose_second_factor":
        return t("auth.secondFactorRequired");
      case "second_factor_code":
        return t("auth.secondFactorSubtitle");
    }
  })();

  return (
    <SafeAreaView className="flex-1 bg-cream">
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        className="flex-1"
      >
        <ScrollView
          contentContainerStyle={{ flexGrow: 1 }}
          keyboardShouldPersistTaps="handled"
          className="px-6"
        >
          <Pressable
            onPress={handleBack}
            className="mt-2 mb-6 min-h-[48px] justify-center self-start"
            accessibilityRole="button"
            accessibilityLabel={t("auth.goBack")}
          >
            <Text className="text-sage text-[16px] font-medium">
              {"<"} {t("common.back")}
            </Text>
          </Pressable>

          <Text className="text-[28px] font-semibold text-charcoal mb-2">
            {title}
          </Text>
          <Text className="text-[15px] text-muted mb-8">{subtitle}</Text>

          {authStep.type === "credentials" && (
            <>
              <View className="mb-4">
                <Input
                  label={t("auth.email")}
                  placeholder={t("auth.emailPlaceholder")}
                  value={email}
                  onChangeText={(value) => {
                    setEmail(value);
                    if (errors.email) {
                      setErrors((current) => ({ ...current, email: undefined }));
                    }
                  }}
                  error={errors.email}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoCorrect={false}
                  textContentType="none"
                  autoComplete="off"
                  testID="sign-in-email"
                  returnKeyType="next"
                  onSubmitEditing={() => passwordRef.current?.focus()}
                />
              </View>

              <View className="mb-2">
                <Input
                  ref={passwordRef}
                  label={t("auth.password")}
                  placeholder="••••••••"
                  value={password}
                  onChangeText={(value) => {
                    setPassword(value);
                    if (errors.password) {
                      setErrors((current) => ({
                        ...current,
                        password: undefined,
                      }));
                    }
                  }}
                  error={errors.password}
                  secureTextEntry
                  textContentType="none"
                  autoComplete="off"
                  testID="sign-in-password"
                  returnKeyType="go"
                  onSubmitEditing={handleSignIn}
                />
              </View>

              <Pressable
                onPress={handleForgotPassword}
                className="self-end mb-6 min-h-[48px] justify-center"
                accessibilityRole="link"
                accessibilityLabel={t("auth.forgotPassword")}
              >
                <Text className="text-sage text-[14px] font-medium">
                  {t("auth.forgotPassword")}
                </Text>
              </Pressable>

              <Button
                title={t("auth.signIn")}
                onPress={handleSignIn}
                loading={loading}
                disabled={loading || oauthLoading !== null}
                className="mb-6"
                testID="sign-in-submit"
              />

              <View className="flex-row items-center mb-6">
                <View className="flex-1 h-[1px] bg-charcoal/10" />
                <Text className="mx-3 text-muted text-[13px]">{t("auth.or")}</Text>
                <View className="flex-1 h-[1px] bg-charcoal/10" />
              </View>

              <View className="gap-3 mb-8">
                {Platform.OS === "ios" && (
                  <Button
                    title={t("auth.continueWithApple")}
                    onPress={() => handleOAuth("apple")}
                    variant="secondary"
                    loading={oauthLoading === "apple"}
                    disabled={loading || oauthLoading !== null}
                    icon={
                      <Ionicons
                        name="logo-apple"
                        size={20}
                        color={COLORS.charcoal}
                      />
                    }
                  />
                )}
                <Button
                  title={t("auth.continueWithGoogle")}
                  onPress={() => handleOAuth("google")}
                  variant="secondary"
                  loading={oauthLoading === "google"}
                  disabled={loading || oauthLoading !== null}
                  icon={
                    <Ionicons
                      name="logo-google"
                      size={18}
                      color={COLORS.charcoal}
                    />
                  }
                />
              </View>

              <View className="flex-row items-center justify-center mb-8">
                <Text className="text-muted text-[15px] text-center">
                  {t("auth.noAccount")}{" "}
                </Text>
                <Pressable
                  onPress={() => router.replace("/(auth)/create-account")}
                  className="min-h-[48px] px-1 items-center justify-center"
                  accessibilityRole="link"
                  accessibilityLabel={t("auth.signUp")}
                >
                  <Text className="text-sage text-[15px] font-semibold text-center">
                    {t("auth.signUp")}
                  </Text>
                </Pressable>
              </View>
            </>
          )}

          {authStep.type === "choose_second_factor" && (
            <View className="gap-3 mb-8">
              {authStep.factors.map((factor) => (
                <Button
                  key={`${factor.strategy}-${factor.emailAddressId || factor.phoneNumberId || factor.safeIdentifier || "default"}`}
                  title={getFactorLabel(factor, t)}
                  onPress={() => prepareSecondFactorCode(factor)}
                  variant="secondary"
                  disabled={loading}
                />
              ))}
            </View>
          )}

          {(authStep.type === "forgot_password_code" ||
            authStep.type === "second_factor_code") && (
            <>
              <View className="mb-4">
                <Input
                  label={getCodeInputLabel(authStep.factor, t)}
                  placeholder={
                    authStep.factor.strategy === "backup_code"
                      ? t("auth.factorLabels.backupCode")
                      : "123456"
                  }
                  value={verificationCode}
                  onChangeText={(value) => {
                    setVerificationCode(value);
                    if (verificationError) {
                      setVerificationError(undefined);
                    }
                  }}
                  error={verificationError}
                  keyboardType={
                    isNumericCodeFactor(authStep.factor)
                      ? "number-pad"
                      : "default"
                  }
                  textContentType={
                    isNumericCodeFactor(authStep.factor)
                      ? "oneTimeCode"
                      : "none"
                  }
                  autoComplete={
                    isNumericCodeFactor(authStep.factor)
                      ? "one-time-code"
                      : "off"
                  }
                  autoCapitalize="none"
                  autoCorrect={false}
                  testID="auth-verification-code"
                />
              </View>

              <Button
                title={
                  authStep.type === "forgot_password_code"
                    ? t("auth.verifyCode")
                    : t("common.continue")
                }
                onPress={
                  authStep.type === "forgot_password_code"
                    ? handleForgotPasswordCodeSubmit
                    : handleSecondFactorSubmit
                }
                loading={loading}
                disabled={loading}
                className="mb-4"
                testID="auth-verification-submit"
              />

              {canResendFactorCode(authStep.factor) && (
                <Button
                  title={t("auth.resendCode")}
                  onPress={handleResendCurrentCode}
                  variant="secondary"
                  disabled={loading}
                  className="mb-4"
                />
              )}
            </>
          )}

          {authStep.type === "forgot_password_new_password" && (
            <>
              <View className="mb-4">
                <Input
                  label={t("auth.newPassword")}
                  placeholder="••••••••"
                  value={newPassword}
                  onChangeText={(value) => {
                    setNewPassword(value);
                    if (resetPasswordError) {
                      setResetPasswordError(undefined);
                    }
                  }}
                  error={resetPasswordError}
                  secureTextEntry
                  textContentType="newPassword"
                  autoComplete="new-password"
                  testID="reset-password-new"
                />
              </View>

              <View className="mb-4">
                <Input
                  label={t("auth.confirmNewPassword")}
                  placeholder="••••••••"
                  value={confirmNewPassword}
                  onChangeText={(value) => {
                    setConfirmNewPassword(value);
                    if (resetPasswordError) {
                      setResetPasswordError(undefined);
                    }
                  }}
                  secureTextEntry
                  textContentType="newPassword"
                  autoComplete="new-password"
                  testID="reset-password-confirm"
                />
              </View>

              <Button
                title={t("auth.updatePassword")}
                onPress={handleResetPasswordSubmit}
                loading={loading}
                disabled={loading}
                className="mb-4"
                testID="reset-password-submit"
              />
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
