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
import { ArrowLeft, ChevronDown, Check } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { Button, Input, KeyboardAwareFooter, Modal, ProgressBar } from "@/src/components/ui";
import { COLORS, RELATIONSHIP_OPTIONS } from "@/src/constants/theme";
import { ApiError, api } from "@/src/lib/api";
import { useOnboardingStore } from "@/src/stores/onboarding";

function sanitizePhoneInput(value: string): string {
  return value.replace(/[^\d+\-\s()]/g, "").slice(0, 20);
}

function phoneDigitCount(value: string): number {
  return value.replace(/\D/g, "").length;
}

function normalizedPhoneDigits(value: string): string {
  return value.replace(/\D/g, "").slice(-10);
}

function phonesMatch(a: string, b: string): boolean {
  const first = normalizedPhoneDigits(a);
  const second = normalizedPhoneDigits(b);
  return first.length === 10 && first === second;
}

function isPhoneAlreadyRegisteredError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;

  const code = typeof error.body.code === "string" ? error.body.code : undefined;
  const message =
    typeof error.body.error === "string" ? error.body.error.toLowerCase() : "";

  return (
    error.status === 409 &&
    (code === "senior_phone_taken" ||
      message.includes("phone number is already registered"))
  );
}

function isCaregiverPhoneMatchError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;

  const code = typeof error.body.code === "string" ? error.body.code : undefined;
  const message =
    typeof error.body.error === "string" ? error.body.error.toLowerCase() : "";

  return (
    code === "senior_phone_matches_caregiver" ||
    message.includes("match caregiver phone")
  );
}

export default function Step2Screen() {
  const router = useRouter();
  const { getToken } = useAuth();
  const { t } = useTranslation();
  const {
    phone,
    lovedOneName,
    lovedOnePhone,
    relationship,
    city,
    state,
    zipcode,
    setField,
  } = useOnboardingStore();

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [checkingPhone, setCheckingPhone] = useState(false);
  const [showRelationshipPicker, setShowRelationshipPicker] = useState(false);

  function validate(): boolean {
    const next: Record<string, string> = {};
    if (!lovedOneName.trim()) next.lovedOneName = t("onboarding.step2.nameRequired");
    if (!lovedOnePhone.trim()) next.lovedOnePhone = t("onboarding.step2.phoneRequired");
    else if (phoneDigitCount(lovedOnePhone) < 10) {
      next.lovedOnePhone = t("onboarding.step2.phoneInvalid");
    }
    if (!relationship) next.relationship = t("onboarding.step2.relationshipRequired");
    if (
      relationship &&
      relationship !== "Myself" &&
      phonesMatch(phone, lovedOnePhone)
    ) {
      next.lovedOnePhone = t("onboarding.step2.phoneMatchesCaregiver");
    }
    if (state.trim() && state.trim().length !== 2)
      next.state = t("onboarding.step2.stateFormat");
    if (zipcode.trim() && zipcode.trim().length !== 5)
      next.zipcode = t("onboarding.step2.zipFormat");
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function handleNext() {
    Keyboard.dismiss();
    if (!validate()) return;

    setCheckingPhone(true);
    try {
      const token = await getToken();
      if (!token) {
        setErrors((current) => ({
          ...current,
          lovedOnePhone: t("onboarding.step2.phoneCheckFailed"),
        }));
        return;
      }

      await api.onboarding.validatePhone(lovedOnePhone, token, {
        caregiverPhone: phone,
        relationship,
      });
      router.push("/(onboarding)/language");
    } catch (error: unknown) {
      if (isCaregiverPhoneMatchError(error)) {
        setErrors((current) => ({
          ...current,
          lovedOnePhone: t("onboarding.step2.phoneMatchesCaregiver"),
        }));
        return;
      }

      if (isPhoneAlreadyRegisteredError(error)) {
        setErrors((current) => ({
          ...current,
          lovedOnePhone: t("onboarding.step2.phoneAlreadyRegistered"),
        }));
        return;
      }

      setErrors((current) => ({
        ...current,
        lovedOnePhone: t("onboarding.step2.phoneCheckFailed"),
      }));
    } finally {
      setCheckingPhone(false);
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
            <ProgressBar current={2} total={6} />
          </View>

          {/* Back */}
          <Pressable
            onPress={() => router.back()}
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
            {t("onboarding.step2.title")}
          </Text>
          <Text className="text-[15px] text-muted mb-8">
            {t("onboarding.step2.subtitle")}
          </Text>

          {/* Form */}
          <View className="gap-4">
            <Input
              label={t("onboarding.step2.name")}
              placeholder="Margaret"
              value={lovedOneName}
              onChangeText={(v) => setField("lovedOneName", v)}
              error={errors.lovedOneName}
              autoCapitalize="words"
              textContentType="name"
              testID="input-their-name"
            />

            <Input
              label={t("onboarding.step2.phone")}
              placeholder="(555) 987-6543"
              value={lovedOnePhone}
              onChangeText={(v) => {
                setField("lovedOnePhone", sanitizePhoneInput(v));
                if (errors.lovedOnePhone) {
                  setErrors((current) => {
                    const next = { ...current };
                    delete next.lovedOnePhone;
                    return next;
                  });
                }
              }}
              error={errors.lovedOnePhone}
              keyboardType="phone-pad"
              autoComplete="off"
              maxLength={20}
              testID="input-their-phone"
            />

            {/* Relationship Picker */}
            <View className="w-full">
              <Text className="text-[13px] font-medium text-muted mb-1.5 uppercase tracking-wider">
                {t("onboarding.step2.relationship")}
              </Text>
              <Pressable
                onPress={() => {
                  Keyboard.dismiss();
                  setShowRelationshipPicker(true);
                }}
                className={`w-full bg-white px-4 py-3.5 rounded-2xl border flex-row items-center justify-between ${
                  errors.relationship ? "border-red-500" : "border-charcoal/10"
                }`}
                accessibilityRole="button"
                accessibilityLabel={t("onboarding.step2.selectRelationship")}
                testID="input-relationship"
              >
                <Text
                  className={`text-[15px] ${relationship ? "text-charcoal" : "text-muted"}`}
                >
                  {relationship ? t(`relationships.${relationship}`) : t("onboarding.step2.selectRelationship")}
                </Text>
                <ChevronDown size={18} color={COLORS.muted} />
              </Pressable>
              {errors.relationship && (
                <Text className="text-red-500 text-[13px] mt-1">
                  {errors.relationship}
                </Text>
              )}
            </View>

            <Input
              label={t("onboarding.step2.city")}
              placeholder="Dallas"
              value={city}
              onChangeText={(v) => setField("city", v)}
              autoCapitalize="words"
              textContentType="addressCity"
              testID="input-city"
            />

            {/* State + Zip side by side */}
            <View className="flex-row gap-3">
              <View className="flex-1">
                <Input
                  label={t("onboarding.step2.state")}
                  placeholder="TX"
                  value={state}
                  onChangeText={(v) =>
                    setField("state", v.toUpperCase().slice(0, 2))
                  }
                  error={errors.state}
                  autoCapitalize="characters"
                  maxLength={2}
                  textContentType="addressState"
                  testID="input-state"
                />
              </View>
              <View className="flex-1">
                <Input
                  label={t("onboarding.step2.zipCode")}
                  placeholder="75201"
                  value={zipcode}
                  onChangeText={(v) =>
                    setField("zipcode", v.replace(/\D/g, "").slice(0, 5))
                  }
                  error={errors.zipcode}
                  keyboardType="number-pad"
                  maxLength={5}
                  textContentType="postalCode"
                  testID="input-zipcode"
                />
              </View>
            </View>
          </View>
        </ScrollView>

        {/* Fixed bottom button */}
        <KeyboardAwareFooter>
          <Button
            title={t("common.next")}
            onPress={handleNext}
            loading={checkingPhone}
            disabled={checkingPhone}
          />
        </KeyboardAwareFooter>
      </KeyboardAvoidingView>

      {/* Relationship picker modal */}
      <Modal
        visible={showRelationshipPicker}
        onClose={() => setShowRelationshipPicker(false)}
        title={t("onboarding.step2.selectRelationship")}
      >
        <View className="gap-1 pb-4">
          {RELATIONSHIP_OPTIONS.map((option) => (
            <Pressable
              key={option}
              onPress={() => {
                setField("relationship", option);
                if (errors.lovedOnePhone) {
                  setErrors((current) => {
                    const next = { ...current };
                    delete next.lovedOnePhone;
                    return next;
                  });
                }
                if (errors.relationship) {
                  setErrors((current) => {
                    const next = { ...current };
                    delete next.relationship;
                    return next;
                  });
                }
                setShowRelationshipPicker(false);
              }}
              className="flex-row items-center justify-between py-3.5 px-2 rounded-xl active:bg-beige"
              accessibilityRole="button"
              accessibilityLabel={t(`relationships.${option}`)}
              testID={`relationship-option-${option}`}
            >
              <Text className="text-[16px] text-charcoal">{t(`relationships.${option}`)}</Text>
              {relationship === option && (
                <Check size={18} color={COLORS.sage} />
              )}
            </Pressable>
          ))}
        </View>
      </Modal>
    </SafeAreaView>
  );
}
