import { useEffect, useState } from "react";
import {
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useAuth, useUser } from "@clerk/clerk-expo";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ArrowLeft } from "lucide-react-native";
import { Button, Input, KeyboardAwareFooter, ProgressBar } from "@/src/components/ui";
import { COLORS } from "@/src/constants/theme";
import { api } from "@/src/lib/api";
import { clearPendingOnboardingSession } from "@/src/lib/pendingOnboardingSession";
import { clearOnboardingDraft, useOnboardingStore } from "@/src/stores/onboarding";

function hasAppleExternalAccount(user: unknown) {
  const externalAccounts = (user as {
    externalAccounts?: Array<{ provider?: string; strategy?: string }>;
  } | null)?.externalAccounts;

  return (
    Array.isArray(externalAccounts) &&
    externalAccounts.some((account) =>
      [account.provider, account.strategy].some((value) =>
        typeof value === "string" && value.toLowerCase().includes("apple"),
      ),
    )
  );
}

export default function Step1Screen() {
  const router = useRouter();
  const { getToken, signOut } = useAuth();
  const { user } = useUser();
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const {
    authProvider,
    firstName,
    lastName,
    phone,
    caregiverCity,
    caregiverState,
    caregiverZipcode,
    setField,
  } =
    useOnboardingStore();

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [exiting, setExiting] = useState(false);
  const isAppleOnboarding =
    authProvider === "apple" || hasAppleExternalAccount(user);

  useEffect(() => {
    if (isAppleOnboarding) {
      if (authProvider !== "apple") {
        setField("authProvider", "apple");
      }
    }
  }, [authProvider, isAppleOnboarding, setField]);

  useEffect(() => {
    const nameParts = user?.fullName?.trim().split(/\s+/).filter(Boolean) ?? [];
    const clerkFirstName = user?.firstName || nameParts[0] || "";
    const clerkLastName = user?.lastName || nameParts.slice(1).join(" ");

    if (!firstName.trim() && clerkFirstName) {
      setField("firstName", clerkFirstName);
    }

    if (!lastName.trim() && clerkLastName) {
      setField("lastName", clerkLastName);
    }
  }, [firstName, lastName, setField, user?.firstName, user?.fullName, user?.lastName]);

  function validate(): boolean {
    const next: Record<string, string> = {};
    if (!isAppleOnboarding) {
      if (!firstName.trim()) next.firstName = t("onboarding.step1.firstNameRequired");
      if (!lastName.trim()) next.lastName = t("onboarding.step1.lastNameRequired");
    }
    if (!phone.trim()) next.phone = t("onboarding.step1.phoneRequired");
    if (!caregiverCity.trim()) next.caregiverCity = t("onboarding.step1.cityRequired");
    if (!caregiverState.trim()) {
      next.caregiverState = t("onboarding.step1.stateRequired");
    } else if (!/^[A-Za-z]{2}$/.test(caregiverState.trim())) {
      next.caregiverState = t("onboarding.step1.stateFormat");
    }
    if (!caregiverZipcode.trim()) {
      next.caregiverZipcode = t("onboarding.step1.zipRequired");
    } else if (!/^\d{5}$/.test(caregiverZipcode.trim())) {
      next.caregiverZipcode = t("onboarding.step1.zipFormat");
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  function handleNext() {
    Keyboard.dismiss();
    if (validate()) {
      router.push("/(onboarding)/step2");
    }
  }

  async function handleBack() {
    Keyboard.dismiss();
    setExiting(true);

    try {
      const token = await getToken();
      if (token) {
        await api.account.cancelIncompleteOnboarding(token);
      }
    } catch {
      // Continue with local cleanup. The pending Clerk account may already be gone.
    } finally {
      clearPendingOnboardingSession();
      try {
        await clearOnboardingDraft();
      } catch {
        // Continue; leaving setup must not be blocked by draft cleanup failure.
      }
      queryClient.removeQueries({ queryKey: ["profile"] });
      try {
        await signOut();
      } catch {
        // The Clerk user may already be deleted server-side.
      }
      router.replace("/");
      setExiting(false);
    }
  }

  return (
    <SafeAreaView className="flex-1 bg-cream">
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        className="flex-1"
      >
        <ScrollView
          contentContainerStyle={{ flexGrow: 1, paddingBottom: 100 }}
          keyboardShouldPersistTaps="handled"
          className="px-6"
        >
          {/* Progress */}
          <View className="mt-4 mb-4">
            <ProgressBar current={1} total={6} />
          </View>

          {/* Back */}
          <Pressable
            onPress={handleBack}
            disabled={exiting}
            className="flex-row items-center mb-6 min-h-[48px] self-start"
            accessibilityRole="button"
            accessibilityLabel={t("common.back")}
          >
            <ArrowLeft size={18} color={COLORS.sage} />
            <Text className="text-sage text-[16px] font-medium ml-1">
              {t("common.back")}
            </Text>
          </Pressable>

          {/* Header */}
          <Text className="text-[28px] font-semibold text-charcoal mb-2">
            {t(isAppleOnboarding ? "onboarding.step1.appleTitle" : "onboarding.step1.title")}
          </Text>
          <Text className="text-[15px] text-muted mb-8">
            {t(isAppleOnboarding ? "onboarding.step1.appleSubtitle" : "onboarding.step1.subtitle")}
          </Text>

          {/* Form */}
          <View className="gap-4">
            {!isAppleOnboarding && (
              <>
                <Input
                  label={t("onboarding.step1.firstName")}
                  placeholder="Jane"
                  value={firstName}
                  onChangeText={(v) => setField("firstName", v)}
                  error={errors.firstName}
                  autoCapitalize="words"
                  textContentType="givenName"
                  autoComplete="given-name"
                  testID="input-first-name"
                />
                <Input
                  label={t("onboarding.step1.lastName")}
                  placeholder="Doe"
                  value={lastName}
                  onChangeText={(v) => setField("lastName", v)}
                  error={errors.lastName}
                  autoCapitalize="words"
                  textContentType="familyName"
                  autoComplete="family-name"
                  testID="input-last-name"
                />
              </>
            )}
            <Input
              label={t("onboarding.step1.phone")}
              placeholder="(555) 123-4567"
              value={phone}
              onChangeText={(v) => setField("phone", v)}
              error={errors.phone}
              keyboardType="phone-pad"
              textContentType="telephoneNumber"
              autoComplete="tel"
              testID="input-phone"
            />
            <Input
              label={t("onboarding.step1.city")}
              placeholder={t("onboarding.step1.cityPlaceholder")}
              value={caregiverCity}
              onChangeText={(v) => setField("caregiverCity", v)}
              error={errors.caregiverCity}
              autoCapitalize="words"
              textContentType="addressCity"
              testID="input-caregiver-city"
            />
            <View className="flex-row gap-3">
              <View className="flex-1">
                <Input
                  label={t("onboarding.step1.state")}
                  placeholder={t("onboarding.step1.statePlaceholder")}
                  value={caregiverState}
                  onChangeText={(v) =>
                    setField("caregiverState", v.toUpperCase().slice(0, 2))
                  }
                  error={errors.caregiverState}
                  autoCapitalize="characters"
                  maxLength={2}
                  textContentType="addressState"
                  testID="input-caregiver-state"
                />
              </View>
              <View className="flex-1">
                <Input
                  label={t("onboarding.step1.zipCode")}
                  placeholder={t("onboarding.step1.zipPlaceholder")}
                  value={caregiverZipcode}
                  onChangeText={(v) =>
                    setField("caregiverZipcode", v.replace(/\D/g, "").slice(0, 5))
                  }
                  error={errors.caregiverZipcode}
                  keyboardType="number-pad"
                  maxLength={5}
                  textContentType="postalCode"
                  testID="input-caregiver-zipcode"
                />
              </View>
            </View>
          </View>
        </ScrollView>

        {/* Fixed bottom button */}
        <KeyboardAwareFooter>
          <Button title={t("common.next")} onPress={handleNext} />
        </KeyboardAwareFooter>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
