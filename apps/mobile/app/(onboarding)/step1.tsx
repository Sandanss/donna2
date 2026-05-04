import { useState } from "react";
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
import { useAuth } from "@clerk/clerk-expo";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ArrowLeft } from "lucide-react-native";
import { Button, Input, KeyboardAwareFooter, ProgressBar } from "@/src/components/ui";
import { COLORS } from "@/src/constants/theme";
import { getProfileQueryKey } from "@/src/lib/profileSession";
import { useOnboardingStore } from "@/src/stores/onboarding";

export default function Step1Screen() {
  const router = useRouter();
  const { signOut, userId } = useAuth();
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const { firstName, lastName, phone, setField } =
    useOnboardingStore();

  const [errors, setErrors] = useState<Record<string, string>>({});

  function validate(): boolean {
    const next: Record<string, string> = {};
    if (!firstName.trim()) next.firstName = t("onboarding.step1.firstNameRequired");
    if (!lastName.trim()) next.lastName = t("onboarding.step1.lastNameRequired");
    if (!phone.trim()) next.phone = t("onboarding.step1.phoneRequired");
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
    if (router.canGoBack()) {
      router.back();
      return;
    }

    queryClient.removeQueries({ queryKey: getProfileQueryKey(userId) });
    await signOut();
    router.replace("/");
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
            {t("onboarding.step1.title")}
          </Text>
          <Text className="text-[15px] text-muted mb-8">
            {t("onboarding.step1.subtitle")}
          </Text>

          {/* Form */}
          <View className="gap-4">
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
