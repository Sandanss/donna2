import { useState } from "react";
import {
  View,
  Text,
  Pressable,
  ScrollView,
  Linking,
  Alert,
  TextInput,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import {
  ArrowLeft,
  ChevronRight,
  HelpCircle,
  Sparkles,
  MessageCircle,
  Flag,
  Lightbulb,
  Shield,
  ExternalLink,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { COLORS } from "@/src/constants/theme";
import { Modal } from "@/src/components/ui/Modal";
import { Button } from "@/src/components/ui/Button";

const SUPPORT_EMAIL = "support@calldonna.co";
const PRIVACY_POLICY_URL = "https://calldonna.co/privacy";
const TERMS_OF_SERVICE_URL = "https://calldonna.co/terms";

type HelpRow = {
  icon: React.ReactNode;
  labelKey: string;
  action: () => void;
};

export default function HelpCenterScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const [contactModalVisible, setContactModalVisible] = useState(false);
  const [reportModalVisible, setReportModalVisible] = useState(false);
  const [suggestModalVisible, setSuggestModalVisible] = useState(false);
  const [feedbackText, setFeedbackText] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmitFeedback = async (type: string) => {
    const message = feedbackText.trim();

    if (!message) {
      Alert.alert(t("helpCenter.required"), t("helpCenter.requiredMessage"));
      return;
    }

    setSubmitting(true);

    const typeLabel = t(`helpCenter.${type}`);
    const subject = encodeURIComponent(`Donna ${typeLabel}`);
    const body = encodeURIComponent(`${message}\n\n${t("helpCenter.emailFooter")}`);

    try {
      await Linking.openURL(`mailto:${SUPPORT_EMAIL}?subject=${subject}&body=${body}`);
      setFeedbackText("");
      setContactModalVisible(false);
      setReportModalVisible(false);
      setSuggestModalVisible(false);
      Alert.alert(t("helpCenter.emailOpened"), t("helpCenter.emailOpenedMessage"));
    } catch {
      Alert.alert(
        t("helpCenter.errorTitle"),
        t("helpCenter.emailFallbackMessage", { email: SUPPORT_EMAIL }),
      );
    } finally {
      setSubmitting(false);
    }
  };

  const openURL = (url: string) => {
    Linking.openURL(url).catch(() =>
      Alert.alert(t("helpCenter.errorTitle"), t("helpCenter.unableToOpenLink"))
    );
  };

  const helpRows: HelpRow[] = [
    {
      icon: <HelpCircle size={18} color={COLORS.sage} />,
      labelKey: "helpCenter.faq",
      action: () =>
        Alert.alert(
          t("helpCenter.faq"),
          t("helpCenter.faqMessage")
        ),
    },
    {
      icon: <Sparkles size={18} color={COLORS.sage} />,
      labelKey: "helpCenter.whatsNew",
      action: () =>
        Alert.alert(
          t("helpCenter.whatsNew"),
          t("helpCenter.whatsNewMessage")
        ),
    },
    {
      icon: <MessageCircle size={18} color={COLORS.sage} />,
      labelKey: "helpCenter.contactSupport",
      action: () => setContactModalVisible(true),
    },
  ];

  const feedbackRows: HelpRow[] = [
    {
      icon: <Flag size={18} color={COLORS.warning} />,
      labelKey: "helpCenter.reportProblem",
      action: () => setReportModalVisible(true),
    },
    {
      icon: <Lightbulb size={18} color={COLORS.sage} />,
      labelKey: "helpCenter.makeSuggestion",
      action: () => setSuggestModalVisible(true),
    },
  ];

  const aboutRows: HelpRow[] = [
    {
      icon: <Shield size={18} color={COLORS.sage} />,
      labelKey: "helpCenter.privacyPolicy",
      action: () => openURL(PRIVACY_POLICY_URL),
    },
    {
      icon: <ExternalLink size={18} color={COLORS.sage} />,
      labelKey: "helpCenter.termsOfService",
      action: () => openURL(TERMS_OF_SERVICE_URL),
    },
  ];

  function renderSection(titleKey: string, rows: HelpRow[]) {
    return (
      <View className="mb-6">
        <Text className="text-[13px] font-medium text-muted uppercase tracking-wider mb-3">
          {t(titleKey)}
        </Text>
        <View className="bg-white rounded-2xl border border-charcoal/10 px-4">
          {rows.map((row, index) => (
            <View key={row.labelKey}>
              <Pressable
                onPress={row.action}
                className="flex-row items-center py-3.5"
                accessibilityRole="button"
                accessibilityLabel={t(row.labelKey)}
                style={{ minHeight: 48 }}
              >
                <View className="w-9 h-9 rounded-full items-center justify-center bg-sage/10">
                  {row.icon}
                </View>
                <Text className="flex-1 text-[15px] text-charcoal ml-3">
                  {t(row.labelKey)}
                </Text>
                <ChevronRight size={18} color={COLORS.muted} />
              </Pressable>
              {index < rows.length - 1 && (
                <View className="h-px bg-charcoal/5 ml-12" />
              )}
            </View>
          ))}
        </View>
      </View>
    );
  }

  function renderFeedbackModal(
    visible: boolean,
    onClose: () => void,
    titleKey: string,
    placeholderKey: string,
    type: string
  ) {
    return (
      <Modal visible={visible} onClose={onClose} title={t(titleKey)}>
        <View className="py-2">
          <Text className="text-[13px] text-muted mb-3">
            {t("helpCenter.privateFeedbackNotice")}
          </Text>
          <TextInput
            className="bg-beige px-4 py-3 rounded-xl text-[15px] text-charcoal border border-charcoal/5"
            placeholder={t(placeholderKey)}
            placeholderTextColor={COLORS.muted}
            value={feedbackText}
            onChangeText={setFeedbackText}
            multiline
            numberOfLines={5}
            style={{ minHeight: 120, textAlignVertical: "top" }}
          />
          <View className="mt-4">
            <Button
              title={t("common.submit")}
              onPress={() => handleSubmitFeedback(type)}
              loading={submitting}
            />
          </View>
        </View>
      </Modal>
    );
  }

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
          {t("helpCenter.title")}
        </Text>
      </View>

      {/* Scrollable Content */}
      <ScrollView
        className="flex-1 px-6"
        contentContainerStyle={{ paddingBottom: 40 }}
        showsVerticalScrollIndicator={false}
      >
        <View className="mt-4">
          {renderSection("helpCenter.help", helpRows)}
          {renderSection("helpCenter.feedback", feedbackRows)}
          {renderSection("helpCenter.about", aboutRows)}
        </View>
      </ScrollView>

      {/* Feedback Modals */}
      {renderFeedbackModal(
        contactModalVisible,
        () => {
          setContactModalVisible(false);
          setFeedbackText("");
        },
        "helpCenter.contactSupport",
        "helpCenter.contactPlaceholder",
        "message"
      )}
      {renderFeedbackModal(
        reportModalVisible,
        () => {
          setReportModalVisible(false);
          setFeedbackText("");
        },
        "helpCenter.reportProblem",
        "helpCenter.reportPlaceholder",
        "report"
      )}
      {renderFeedbackModal(
        suggestModalVisible,
        () => {
          setSuggestModalVisible(false);
          setFeedbackText("");
        },
        "helpCenter.makeSuggestion",
        "helpCenter.suggestPlaceholder",
        "suggestion"
      )}
    </SafeAreaView>
  );
}
