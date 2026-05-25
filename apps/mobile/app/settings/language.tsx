import { useState, useEffect } from "react";
import { View, Text, Pressable, ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { ArrowLeft, Check } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { COLORS } from "@/src/constants/theme";
import { FlagUS } from "@/src/components/icons/FlagUS";
import { FlagMX } from "@/src/components/icons/FlagMX";
import { getStoredLanguage, setStoredLanguage } from "@/src/i18n";

const LANGUAGES = [
  { code: "en", nativeLabel: "English", Flag: FlagUS },
  { code: "es", nativeLabel: "Espanol", Flag: FlagMX },
] as const;

export default function LanguageSettingsScreen() {
  const router = useRouter();
  const { t, i18n } = useTranslation();
  const [currentLang, setCurrentLang] = useState(i18n.language);

  useEffect(() => {
    getStoredLanguage().then(setCurrentLang);
  }, []);

  const handleSelect = async (code: string) => {
    setCurrentLang(code);
    await setStoredLanguage(code);
  };

  return (
    <SafeAreaView className="flex-1 bg-cream">
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
          {t("languageScreen.title")}
        </Text>
        <Text className="text-[15px] text-muted mt-1">
          {t("languageScreen.subtitle")}
        </Text>
      </View>

      {/* Language Options */}
      <ScrollView
        className="flex-1 px-6"
        contentContainerStyle={{ paddingBottom: 40 }}
        showsVerticalScrollIndicator={false}
      >
        <View className="mt-4 bg-white rounded-2xl border border-charcoal/10 px-4">
          {LANGUAGES.map((lang, index) => {
            const isSelected = currentLang === lang.code;
            return (
              <View key={lang.code}>
                <Pressable
                  onPress={() => handleSelect(lang.code)}
                  className="flex-row items-center justify-between py-4 px-1"
                  accessibilityRole="radio"
                  accessibilityState={{ selected: isSelected }}
                  accessibilityLabel={lang.nativeLabel}
                  style={{ minHeight: 56 }}
                >
                  <View className="flex-row items-center gap-3">
                    <lang.Flag size={28} />
                    <Text className="text-[16px] font-medium text-charcoal">
                      {lang.nativeLabel}
                    </Text>
                  </View>
                  {isSelected && <Check size={20} color={COLORS.sage} />}
                </Pressable>
                {index < LANGUAGES.length - 1 && (
                  <View className="h-px bg-charcoal/5" />
                )}
              </View>
            );
          })}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
