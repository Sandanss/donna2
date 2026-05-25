import { Pressable, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { ArrowLeft } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { Button, ProgressBar } from "@/src/components/ui";
import { COLORS } from "@/src/constants/theme";
import { useOnboardingStore } from "@/src/stores/onboarding";

const LANGUAGES = [
  { code: "en" as const, label: "English", badge: "En" },
  { code: "es" as const, label: "Spanish", badge: "Es" },
];

export default function LanguageScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const { donnaLanguage, setField } = useOnboardingStore();

  return (
    <SafeAreaView className="flex-1 bg-cream">
      <View className="flex-1 px-6">
        {/* Progress */}
        <View className="mt-4 mb-4">
          <ProgressBar current={3} total={6} />
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
          {t("onboarding.language.title")}
        </Text>
        <Text className="text-[15px] text-muted mb-8">
          {t("onboarding.language.subtitle")}
        </Text>

        {/* Language Options */}
        <View className="gap-3">
          {LANGUAGES.map((lang) => {
            const isSelected = donnaLanguage === lang.code;
            return (
              <Pressable
                key={lang.code}
                onPress={() => setField("donnaLanguage", lang.code)}
                className={`flex-row items-center px-5 py-4 rounded-2xl border-2 ${
                  isSelected
                    ? "border-sage bg-sage/5"
                    : "border-charcoal/10 bg-white"
                }`}
                accessibilityRole="radio"
                accessibilityState={{ selected: isSelected }}
                accessibilityLabel={lang.label}
                style={{ minHeight: 56 }}
              >
                <View
                  className={`w-10 h-10 rounded-full items-center justify-center mr-4 ${
                    isSelected ? "bg-sage" : "bg-beige"
                  }`}
                >
                  <Text
                    className={`text-[14px] font-semibold ${
                      isSelected ? "text-white" : "text-charcoal"
                    }`}
                  >
                    {lang.badge}
                  </Text>
                </View>
                <Text
                  className={`text-[17px] font-medium ${
                    isSelected ? "text-sage" : "text-charcoal"
                  }`}
                >
                  {lang.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      {/* Fixed bottom button */}
      <View className="bg-cream border-t border-charcoal/10 px-6 pt-4 pb-8">
        <Button
          title={t("common.next")}
          onPress={() => router.push("/(onboarding)/step3")}
        />
      </View>
    </SafeAreaView>
  );
}
