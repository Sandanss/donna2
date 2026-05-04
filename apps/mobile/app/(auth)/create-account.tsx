import { useAuth, useOAuth, useSignInWithApple, useSignUp } from "@clerk/clerk-expo";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useState } from "react";
import {
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { useTranslation } from "react-i18next";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "@/src/components/ui/Button";
import { Input } from "@/src/components/ui/Input";
import { COLORS } from "@/src/constants/theme";
import { api, getErrorMessage } from "@/src/lib/api";
import { getClerkErrorMessage, getClerkFieldErrors } from "@/src/lib/clerkErrors";
import { resolvePostAuthRoute } from "@/src/lib/profileSession";

WebBrowser.maybeCompleteAuthSession();

const MIN_PASSWORD_LENGTH = 10;

function isBreachedPasswordError(error: unknown): boolean {
  if (
    typeof error === "object" &&
    error !== null &&
    Array.isArray((error as { errors?: unknown[] }).errors)
  ) {
    return (error as {
      errors: Array<{ code?: string; message?: string; longMessage?: string }>;
    }).errors.some(
      (entry) => {
        const text = `${entry.code ?? ""} ${entry.message ?? ""} ${
          entry.longMessage ?? ""
        }`.toLowerCase();
        return (
          text.includes("pwn") ||
          text.includes("breach") ||
          text.includes("data leak") ||
          text.includes("compromised")
        );
      },
    );
  }

  return error instanceof Error
    ? /pwn|breach|data leak|compromised/i.test(error.message)
    : false;
}

function isExistingAccountError(error: unknown): boolean {
  if (
    typeof error === "object" &&
    error !== null &&
    Array.isArray((error as { errors?: unknown[] }).errors)
  ) {
    return (error as {
      errors: Array<{ code?: string; message?: string; longMessage?: string }>;
    }).errors.some((entry) => {
      const text = `${entry.code ?? ""} ${entry.message ?? ""} ${
        entry.longMessage ?? ""
      }`.toLowerCase();
      return (
        text.includes("identifier_exists") ||
        text.includes("form_identifier_exists") ||
        text.includes("already exists") ||
        text.includes("already in use") ||
        text.includes("already an account") ||
        text.includes("already registered")
      );
    });
  }

  return error instanceof Error
    ? /identifier_exists|form_identifier_exists|already exists|already in use|already an account|already registered/i.test(
        error.message,
      )
    : false;
}

export default function CreateAccountScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { signUp, setActive, isLoaded } = useSignUp();
  const { getToken } = useAuth();
  const { startOAuthFlow: startGoogleOAuth } = useOAuth({
    strategy: "oauth_google",
  });
  const { startAppleAuthenticationFlow } = useSignInWithApple();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [oauthLoading, setOauthLoading] = useState<
    "google" | "apple" | null
  >(null);
  const [errors, setErrors] = useState<{ email?: string; password?: string }>(
    {}
  );
  const [existingAccountEmail, setExistingAccountEmail] = useState<string | null>(
    null,
  );

  async function navigateAfterAuth() {
    const token = await getToken();
    if (!token) {
      Alert.alert("Sign Up Complete", "Please sign in again to continue.");
      return;
    }

    try {
      const nextRoute = resolvePostAuthRoute({
        profile: await api.caregivers.me(token),
      });
      if (nextRoute) {
        router.replace(nextRoute as any);
        return;
      }
    } catch (error) {
      const nextRoute = resolvePostAuthRoute({ error });
      if (nextRoute) {
        router.replace(nextRoute as any);
        return;
      }
      Alert.alert(
        "Sign Up Complete",
        getErrorMessage(
          error,
          "We created your account, but couldn't load your Donna profile right now. Please try again in a moment.",
          "auth",
        ),
      );
      return;
    }

    router.replace("/(onboarding)/step1" as any);
  }

  function handleBack() {
    router.back();
  }

  async function handleCreateAccount() {
    Keyboard.dismiss();
    const nextErrors: { email?: string; password?: string } = {};

    if (!email.trim()) nextErrors.email = t("auth.emailRequired");
    if (!password) nextErrors.password = t("auth.passwordRequired");
    if (password && password.length < MIN_PASSWORD_LENGTH) {
      nextErrors.password = t("auth.passwordTooShort", { count: MIN_PASSWORD_LENGTH });
    }

    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    if (!isLoaded) return;

    setLoading(true);

    try {
      const result = await signUp.create({
        emailAddress: email.trim(),
        password,
      });

      if (result.createdSessionId) {
        await setActive({ session: result.createdSessionId });
        await navigateAfterAuth();
        return;
      }

      if (
        Array.isArray((result as any).unverifiedFields) &&
        (result as any).unverifiedFields.includes("email_address")
      ) {
        throw new Error(
          "Email verification is still enabled for mobile sign-up in Clerk. Turn it off before using this flow."
        );
      }

      Alert.alert(
        t("auth.signUpFailed"),
        t("auth.couldNotCreateAccount"),
      );
    } catch (err: unknown) {
      if (isExistingAccountError(err)) {
        setExistingAccountEmail(email.trim());
        setErrors((current) => ({
          ...current,
          email: t("auth.accountAlreadyExists"),
        }));
        return;
      }

      const clerkFieldErrors = getClerkFieldErrors(err);
      const nextFieldErrors = {
        email: clerkFieldErrors.emailAddress,
        password: isBreachedPasswordError(err)
          ? t("auth.breachedPassword")
          : clerkFieldErrors.password,
      };

      if (nextFieldErrors.email || nextFieldErrors.password) {
        setErrors((current) => ({
          ...current,
          ...nextFieldErrors,
        }));
      } else {
        Alert.alert(
          t("auth.signUpFailed"),
          getClerkErrorMessage(err, t("auth.couldNotCreateAccount"))
        );
      }
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
        result = await startAppleAuthenticationFlow();
      } else {
        result = await startGoogleOAuth();
      }

      const sessionId =
        result.createdSessionId ??
        (result.signIn as any)?.createdSessionId ??
        (result.signUp as any)?.createdSessionId;
      const activateFn = result.setActive;

      if (sessionId && activateFn) {
        await activateFn({ session: sessionId });
        await navigateAfterAuth();
        return;
      }

      // Handle "needs_new_password" — auto-set a random password so OAuth
      // users aren't blocked by a password requirement from a prior account.
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
          await navigateAfterAuth();
          return;
        }
      }
    } catch (err: unknown) {
      if (isExistingAccountError(err)) {
        Alert.alert(
          t("auth.accountAlreadyExistsTitle"),
          t("auth.accountAlreadyExistsOAuth"),
          [
            { text: t("common.cancel"), style: "cancel" },
            {
              text: t("auth.signIn"),
              onPress: () => router.replace("/(auth)/sign-in"),
            },
          ],
        );
        return;
      }

      const message = getClerkErrorMessage(err, "");
      if (message) {
        Alert.alert(
          t("auth.oauthError"),
          message || `${provider} sign up failed`,
        );
      }
    } finally {
      setOauthLoading(null);
    }
  }

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
            {t("auth.createAccount")}
          </Text>
          <Text className="text-[15px] text-muted mb-8">
            {t("auth.createAccountSubtitle")}
          </Text>

          <View className="mb-4">
            <Input
              label={t("auth.email")}
              placeholder={t("auth.emailPlaceholder")}
              value={email}
              onChangeText={(value) => {
                setEmail(value);
                if (existingAccountEmail) setExistingAccountEmail(null);
                if (errors.email) {
                  setErrors((current) => ({ ...current, email: undefined }));
                }
              }}
              error={errors.email}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              textContentType="emailAddress"
              autoComplete="email"
              testID="create-account-email"
            />
            {existingAccountEmail && (
              <Button
                title={t("auth.signInInstead")}
                onPress={() => router.replace("/(auth)/sign-in")}
                variant="secondary"
                className="mt-3"
                testID="create-account-existing-email-sign-in"
              />
            )}
          </View>

          <View className="mb-6">
            <Input
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
              textContentType="oneTimeCode"
              autoComplete="one-time-code"
              returnKeyType="done"
              onSubmitEditing={handleCreateAccount}
              testID="create-account-password"
            />
            {!errors.password && (
              <Text className="text-muted text-[13px] mt-2 leading-5">
                {t("auth.passwordMinLength", { count: MIN_PASSWORD_LENGTH })}
              </Text>
            )}
          </View>

          <Button
            title={t("common.continue")}
            onPress={handleCreateAccount}
            loading={loading}
            disabled={loading || oauthLoading !== null}
            className="mb-6"
            testID="create-account-submit"
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

          <View className="flex-row justify-center mb-8">
            <Text className="text-muted text-[15px]">
              {t("auth.hasAccount")}{" "}
            </Text>
            <Pressable
              onPress={() => router.replace("/(auth)/sign-in")}
              className="min-h-[48px] justify-center"
              accessibilityRole="link"
              accessibilityLabel={t("auth.signIn")}
            >
              <Text className="text-sage text-[15px] font-semibold">
                {t("auth.signIn")}
              </Text>
            </Pressable>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
