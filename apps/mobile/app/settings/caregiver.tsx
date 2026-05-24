import { useState, useEffect } from "react";
import {
  Keyboard,
  View,
  Text,
  Pressable,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useAuth, useUser } from "@clerk/clerk-expo";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ChevronDown } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { COLORS, RELATIONSHIP_OPTIONS } from "@/src/constants/theme";
import { Input } from "@/src/components/ui/Input";
import { Button } from "@/src/components/ui/Button";
import { Modal } from "@/src/components/ui/Modal";
import { KeyboardAwareFooter } from "@/src/components/ui/KeyboardAwareFooter";
import { useProfile } from "@/src/hooks";
import { useStableIdempotencyKey } from "@/src/hooks/useStableIdempotencyKey";
import { api, getErrorMessage } from "@/src/lib/api";
import { getProfileQueryKey } from "@/src/lib/profileSession";
import { resolveTimezoneFromLocation } from "@/src/lib/timezone";

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

export default function CaregiverProfileScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const { user } = useUser();
  const { getToken, userId } = useAuth();
  const queryClient = useQueryClient();
  const { data: profile } = useProfile();
  const idempotency = useStableIdempotencyKey("caregiver-profile-update");

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [caregiverCity, setCaregiverCity] = useState("");
  const [caregiverState, setCaregiverState] = useState("");
  const [caregiverZipcode, setCaregiverZipcode] = useState("");
  const [relationship, setRelationship] = useState("");
  const [showRelationshipPicker, setShowRelationshipPicker] = useState(false);
  const [saving, setSaving] = useState(false);
  const isAppleProfile = hasAppleExternalAccount(user);

  // Pre-fill from Clerk user data
  useEffect(() => {
    if (user) {
      const caregiver = profile?.caregiver;
      setFirstName(user.firstName ?? "");
      setLastName(user.lastName ?? "");
      setEmail(user.primaryEmailAddress?.emailAddress ?? "");
      setPhone(caregiver?.phone ?? user.primaryPhoneNumber?.phoneNumber ?? "");
      // Relationship is stored in unsafeMetadata
      const meta = user.unsafeMetadata as Record<string, unknown>;
      setRelationship((meta?.relationship as string) ?? "");
      setCaregiverCity(caregiver?.city ?? "");
      setCaregiverState(caregiver?.state ?? "");
      setCaregiverZipcode(caregiver?.zipCode ?? "");
    }
  }, [profile?.caregiver, user]);

  const handleSave = async () => {
    if (!user) return;
    setSaving(true);
    try {
      const token = await getToken();
      if (!token) throw new Error("Authentication required");

      const caregiverUpdate = {
        phone: phone.trim() || undefined,
        city: caregiverCity.trim() || undefined,
        state: caregiverState.trim().toUpperCase() || undefined,
        zipCode: caregiverZipcode.trim() || undefined,
        timezone: resolveTimezoneFromLocation({
          city: caregiverCity.trim() || undefined,
          state: caregiverState.trim() || undefined,
        }),
      };

      const updatedProfile = await api.caregivers.updateProfile(caregiverUpdate, token, {
        idempotencyKey: idempotency.getKey(caregiverUpdate),
      });
      await user.update(
        isAppleProfile
          ? {
              unsafeMetadata: {
                ...user.unsafeMetadata,
                relationship,
              },
            }
          : {
              firstName: firstName.trim(),
              lastName: lastName.trim(),
              unsafeMetadata: {
                ...user.unsafeMetadata,
                relationship,
              },
            },
      );
      if (userId) {
        queryClient.setQueryData(getProfileQueryKey(userId), updatedProfile);
      } else {
        await queryClient.invalidateQueries({ queryKey: ["profile"] });
      }
      await queryClient.invalidateQueries({ queryKey: ["notificationPreferences"] });
      idempotency.reset();
      router.replace("/(tabs)/settings");
    } catch (error) {
      Alert.alert(
        t("caregiverProfile.couldntSave"),
        getErrorMessage(error, t("caregiverProfile.couldntSaveMessage"), "save"),
      );
    } finally {
      setSaving(false);
    }
  };

  const handleChangePassword = () => {
    Alert.alert(
      t("caregiverProfile.changePassword"),
      t("caregiverProfile.changePasswordMessage"),
      [
        { text: t("common.ok") },
      ]
    );
  };

  return (
    <SafeAreaView className="flex-1 bg-cream">
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        className="flex-1"
      >
        {/* Header */}
        <View className="px-6 pt-4 pb-2">
          <Pressable
            onPress={() => router.back()}
            className="flex-row items-center gap-2"
            accessibilityRole="button"
            accessibilityLabel={t("common.goBack")}
            style={{ minHeight: 48 }}
          >
            <ArrowLeft size={20} color={COLORS.charcoal} />
            <Text className="text-[15px] text-charcoal">{t("common.back")}</Text>
          </Pressable>
          <Text className="text-[28px] font-semibold text-charcoal mt-4">
            {t("caregiverProfile.title")}
          </Text>
        </View>

        {/* Scrollable Form */}
        <ScrollView
          className="flex-1 px-6"
          contentContainerStyle={{ paddingBottom: 120 }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <View className="gap-4 mt-4">
            {!isAppleProfile && (
              <View className="flex-row gap-3">
                <View className="flex-1">
                  <Input
                    label={t("caregiverProfile.firstName")}
                    value={firstName}
                    onChangeText={setFirstName}
                    placeholder={t("caregiverProfile.firstNamePlaceholder")}
                    testID="caregiver-first-name-input"
                  />
                </View>
                <View className="flex-1">
                  <Input
                    label={t("caregiverProfile.lastName")}
                    value={lastName}
                    onChangeText={setLastName}
                    placeholder={t("caregiverProfile.lastNamePlaceholder")}
                    testID="caregiver-last-name-input"
                  />
                </View>
              </View>
            )}

            <Input
              label={t("caregiverProfile.email")}
              value={email}
              onChangeText={setEmail}
              placeholder={t("caregiverProfile.emailPlaceholder")}
              keyboardType="email-address"
              autoCapitalize="none"
              editable={false}
              className="opacity-60"
            />

            <Input
              label={t("caregiverProfile.phone")}
              value={phone}
              onChangeText={setPhone}
              placeholder={t("caregiverProfile.phonePlaceholder")}
              keyboardType="phone-pad"
              testID="caregiver-phone-input"
            />

            <Input
              label={t("caregiverProfile.city")}
              value={caregiverCity}
              onChangeText={setCaregiverCity}
              placeholder={t("caregiverProfile.cityPlaceholder")}
              autoCapitalize="words"
              textContentType="addressCity"
              testID="caregiver-city-input"
            />

            <View className="flex-row gap-3">
              <View className="flex-1">
                <Input
                  label={t("caregiverProfile.state")}
                  value={caregiverState}
                  onChangeText={(value) =>
                    setCaregiverState(value.toUpperCase().slice(0, 2))
                  }
                  placeholder={t("caregiverProfile.statePlaceholder")}
                  autoCapitalize="characters"
                  maxLength={2}
                  textContentType="addressState"
                  testID="caregiver-state-input"
                />
              </View>
              <View className="flex-1">
                <Input
                  label={t("caregiverProfile.zipCode")}
                  value={caregiverZipcode}
                  onChangeText={(value) =>
                    setCaregiverZipcode(value.replace(/\D/g, "").slice(0, 5))
                  }
                  placeholder={t("caregiverProfile.zipPlaceholder")}
                  keyboardType="number-pad"
                  maxLength={5}
                  textContentType="postalCode"
                  testID="caregiver-zip-input"
                />
              </View>
            </View>

            {/* Relationship Dropdown */}
            <View className="w-full">
              <Text className="text-[13px] font-medium text-muted mb-1.5 uppercase tracking-wider">
                {t("caregiverProfile.relationship")}
              </Text>
              <Pressable
                onPress={() => {
                  Keyboard.dismiss();
                  setShowRelationshipPicker(true);
                }}
                className="w-full bg-white px-4 py-3.5 rounded-2xl border border-charcoal/10 flex-row items-center justify-between"
                accessibilityRole="button"
                accessibilityLabel={t("caregiverProfile.selectRelationship")}
                testID="caregiver-relationship-input"
                style={{ minHeight: 48 }}
              >
                <Text
                  className={`text-[15px] ${
                    relationship ? "text-charcoal" : "text-muted"
                  }`}
                >
                  {relationship ? t(`relationships.${relationship}`) : t("caregiverProfile.selectRelationship")}
                </Text>
                <ChevronDown size={18} color={COLORS.muted} />
              </Pressable>
            </View>
          </View>

          {/* Change Password */}
          <View className="mt-8">
            <Button
              title={t("caregiverProfile.changePassword")}
              variant="secondary"
              onPress={handleChangePassword}
            />
          </View>
        </ScrollView>

        <KeyboardAwareFooter>
          <Button
            title={t("common.save")}
            onPress={handleSave}
            loading={saving}
          />
        </KeyboardAwareFooter>
      </KeyboardAvoidingView>

      {/* Relationship Picker Modal */}
      <Modal
        visible={showRelationshipPicker}
        onClose={() => setShowRelationshipPicker(false)}
        title={t("caregiverProfile.selectRelationshipTitle")}
      >
        <View className="py-2">
          {RELATIONSHIP_OPTIONS.map((option) => (
            <Pressable
              key={option}
              onPress={() => {
                setRelationship(option);
                setShowRelationshipPicker(false);
              }}
              className={`py-3.5 px-2 rounded-xl ${
                relationship === option ? "bg-sage/10" : ""
              }`}
              accessibilityRole="button"
              accessibilityLabel={t(`relationships.${option}`)}
              testID={`caregiver-relationship-option-${option}`}
              style={{ minHeight: 48 }}
            >
              <Text
                className={`text-[15px] ${
                  relationship === option
                    ? "text-sage font-medium"
                    : "text-charcoal"
                }`}
              >
                {t(`relationships.${option}`)}
              </Text>
            </Pressable>
          ))}
        </View>
      </Modal>
    </SafeAreaView>
  );
}
