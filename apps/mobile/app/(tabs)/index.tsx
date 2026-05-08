import { useState, useCallback, useMemo } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  TextInput,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useUser } from "@clerk/clerk-expo";
import { Phone, Calendar } from "lucide-react-native";
import * as Haptics from "expo-haptics";
import { format, differenceInCalendarDays } from "date-fns";
import { useTranslation } from "react-i18next";
import { getDateFnsLocale } from "@/src/lib/dateFnsLocale";
import { COLORS } from "@/src/constants/theme";
import {
  useCurrentSenior,
  useConversations,
  useInitiateCall,
  useSchedule,
} from "@/src/hooks";
import { Button } from "@/src/components/ui";
import { Modal } from "@/src/components/ui";
import { getErrorMessage } from "@/src/lib/api";
import {
  formatTime12h,
  getDatePartsInTimezone,
  parseTimeString,
  resolveSeniorTimezone,
  zonedWallTimeToUtcDate,
} from "@/src/lib/timezone";
import type { Conversation } from "@/src/types";

// --- Next-call computation ---

const DAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function localDateForOffset(
  base: { year: number; month: number; day: number },
  offset: number,
) {
  const date = new Date(Date.UTC(base.year, base.month - 1, base.day + offset));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function localDateMs(parts: { year: number; month: number; day: number }) {
  return Date.UTC(parts.year, parts.month - 1, parts.day);
}

function getNextCallDate(
  scheduleData: { days?: string[]; time?: string } | null | undefined,
  timezone: string,
): Date | null {
  if (!scheduleData?.time) return null;

  const parsed = parseTimeString(scheduleData.time);
  if (!parsed) return null;

  const now = new Date();
  const nowLocal = getDatePartsInTimezone(now, timezone);
  const days = scheduleData.days;

  // Check the next 7 days for a matching day
  for (let offset = 0; offset <= 7; offset++) {
    const localDate = localDateForOffset(nowLocal, offset);
    const localDayIndex = new Date(localDateMs(localDate)).getUTCDay();
    const dayName = DAYS_SHORT[localDayIndex];
    if (days?.length && !days.includes(dayName)) continue;

    const candidate = zonedWallTimeToUtcDate(
      {
        ...localDate,
        hours: parsed.hours,
        minutes: parsed.minutes,
      },
      timezone,
    );
    if (candidate.getTime() > now.getTime()) {
      return candidate;
    }
  }

  return null;
}

function formatNextCall(nextDate: Date | null, timezone: string, t: (key: string, opts?: Record<string, unknown>) => string): string {
  if (!nextDate) return t("dashboard.noCallsScheduled");

  const nowLocal = getDatePartsInTimezone(new Date(), timezone);
  const nextLocal = getDatePartsInTimezone(nextDate, timezone);
  const dayDiff = Math.round(
    (localDateMs(nextLocal) - localDateMs(nowLocal)) / (24 * 60 * 60 * 1000),
  );
  const timeStr = formatTime12h(nextLocal.hours, nextLocal.minutes);

  if (dayDiff === 0) return t("dashboard.todayAt", { time: timeStr });
  if (dayDiff === 1) return t("dashboard.tomorrowAt", { time: timeStr });
  return t("dashboard.inDaysAt", { count: dayDiff, time: timeStr });
}

// --- Status badge ---

function getCallStatusKey(conversation: Conversation): "answered" | "missed" {
  const duration = conversation.durationSeconds ?? 0;
  if (
    conversation.status === "completed" ||
    (conversation.endedAt && duration > 10)
  ) {
    return "answered";
  }
  return "missed";
}

// --- Component ---

export default function DashboardScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { user } = useUser();
  const { senior, seniorId, isLoading: seniorLoading } = useCurrentSenior();
  const {
    data: conversations,
    isLoading: convoLoading,
    refetch: refetchConversations,
  } = useConversations(seniorId);
  const { data: scheduleData, isLoading: scheduleLoading } = useSchedule(seniorId);
  const initiateCall = useInitiateCall();

  const [callModalVisible, setCallModalVisible] = useState(false);
  const [callContext, setCallContext] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  const caregiverName = user?.firstName ?? null;
  const seniorName = senior?.name ?? t("dashboard.yourLovedOne");
  const seniorFirstName = seniorName.split(" ")[0];
  const seniorTimezone = useMemo(() => resolveSeniorTimezone(senior), [senior]);

  // Resolve schedule: try the schedule endpoint, fall back to senior.preferredCallTimes
  // Handles both legacy shape { days, time } and new ScheduleItem[] from schedule tab
  const resolvedSchedule = useMemo((): { days?: string[]; time?: string } | null => {
    const sd = scheduleData as Record<string, any> | null | undefined;
    const raw = sd?.schedule ?? senior?.preferredCallTimes?.schedule;

    if (!raw) {
      // Top-level legacy shape: { days, time }
      if (sd?.days || sd?.time) return sd as { days?: string[]; time?: string };
      return null;
    }

    // New shape: ScheduleItem[] — find the next applicable call
    if (Array.isArray(raw)) {
      const dayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      const todayIndex = new Date().getDay();

      for (const item of raw as any[]) {
        if (!item.time) continue;

        if (item.frequency === "daily") {
          return { days: dayLabels, time: item.time };
        }
        if (item.frequency === "recurring" && item.recurringDays?.length > 0) {
          return {
            days: (item.recurringDays as number[]).map((d: number) => dayLabels[d]),
            time: item.time,
          };
        }
        // one-time or no frequency — treat as daily
        return { time: item.time };
      }
      return null;
    }

    // Legacy object shape: { days, time }
    if (raw.time || raw.days) {
      return raw as { days?: string[]; time?: string };
    }

    return null;
  }, [scheduleData, senior?.preferredCallTimes]);

  const nextCallDate = useMemo(
    () => getNextCallDate(resolvedSchedule, seniorTimezone),
    [resolvedSchedule, seniorTimezone],
  );
  const nextCallText = useMemo(
    () => formatNextCall(nextCallDate, seniorTimezone, t),
    [nextCallDate, seniorTimezone, t],
  );

  const recentConversations = useMemo(
    () => (conversations ?? []).slice(0, 5),
    [conversations]
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refetchConversations();
    setRefreshing(false);
  }, [refetchConversations]);

  const handleOpenCallModal = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setCallModalVisible(true);
  }, []);

  const handleInitiateCall = useCallback(async () => {
    if (!senior?.id) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      await initiateCall.mutateAsync(senior.id);
      setCallModalVisible(false);
      setCallContext("");
    } catch {
      // Error is handled by react-query -- could show alert here
    }
  }, [senior?.id, initiateCall]);

  // Loading state
  if (seniorLoading) {
    return (
      <SafeAreaView className="flex-1 bg-cream">
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" color={COLORS.sage} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={["top"]}>
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingBottom: 120 }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={COLORS.sage}
          />
        }
      >
        {/* Greeting */}
        <View className="px-6 pt-4 pb-2">
          <Text className="text-[28px] font-semibold text-charcoal">
            {caregiverName ? t("dashboard.greeting", { name: caregiverName }) : t("dashboard.greetingNoName")}
          </Text>
          <Text className="text-[15px] text-muted mt-1">
            {t("dashboard.subtitle", { name: seniorFirstName })}
          </Text>
        </View>

        {/* Next Call Card */}
        <Pressable
          className="mx-6 mt-4 rounded-[20px] bg-sage p-6"
          style={{
            shadowColor: "#000",
            shadowOffset: { width: 0, height: 2 },
            shadowOpacity: 0.1,
            shadowRadius: 8,
            elevation: 3,
          }}
          onPress={() => router.push("/(tabs)/schedule")}
          accessibilityRole="button"
          accessibilityLabel={`${t("dashboard.nextCall")}: ${nextCallText}`}
        >
          <View className="flex-row items-center mb-3">
            <Calendar size={16} color={COLORS.white} />
            <Text className="text-white/70 text-[11px] font-semibold tracking-widest ml-2">
              {t("dashboard.nextCall")}
            </Text>
          </View>
          {scheduleLoading ? (
            <ActivityIndicator size="small" color={COLORS.white} />
          ) : (
            <Text className="text-white text-[20px] font-semibold">
              {nextCallText}
            </Text>
          )}
        </Pressable>

        {/* Recent Call Highlights */}
        <View className="px-6 mt-8">
          <Text className="text-[20px] font-semibold text-charcoal mb-4">
            {t("dashboard.recentHighlights")}
          </Text>

          {convoLoading ? (
            <ActivityIndicator
              size="small"
              color={COLORS.sage}
              style={{ marginTop: 16 }}
            />
          ) : recentConversations.length === 0 ? (
            <View
              className="bg-white rounded-2xl p-6 items-center"
              style={{ borderWidth: 1, borderColor: COLORS.border }}
            >
              <Phone size={32} color={COLORS.muted} />
              <Text className="text-muted text-[15px] mt-3 text-center">
                {t("dashboard.noRecentCalls", { name: seniorFirstName })}
              </Text>
            </View>
          ) : (
            recentConversations.map((convo) => (
              <CallCard key={convo.id} conversation={convo} />
            ))
          )}
        </View>
      </ScrollView>

      {/* Floating Phone Button */}
      <Pressable
        className="absolute right-6 bottom-28 w-14 h-14 rounded-full items-center justify-center"
        style={{
          backgroundColor: COLORS.accentPink,
          shadowColor: COLORS.accentPink,
          shadowOffset: { width: 0, height: 4 },
          shadowOpacity: 0.35,
          shadowRadius: 8,
          elevation: 5,
        }}
        onPress={handleOpenCallModal}
        accessibilityRole="button"
        accessibilityLabel={t("dashboard.callNow", { name: seniorFirstName })}
        testID="instant-call-open"
      >
        <Phone size={24} color={COLORS.white} />
      </Pressable>

      {/* Instant Call Modal */}
      <Modal
        visible={callModalVisible}
        onClose={() => setCallModalVisible(false)}
        title={t("dashboard.instantCall")}
        variant="bottom-sheet"
      >
        <View className="pb-6">
          <Text className="text-muted text-[14px] mb-3">
            {t("dashboard.callContext")}
          </Text>
          <TextInput
            className="bg-beige rounded-2xl p-4 text-charcoal text-[15px] min-h-[100px]"
            placeholder={t("dashboard.callContextPlaceholder", { name: seniorFirstName })}
            placeholderTextColor={COLORS.muted}
            multiline
            textAlignVertical="top"
            value={callContext}
            onChangeText={setCallContext}
          />
          <View className="mt-5">
            <Button
              title={t("dashboard.callNow", { name: seniorFirstName })}
              onPress={handleInitiateCall}
              loading={initiateCall.isPending}
              disabled={initiateCall.isPending}
              icon={<Phone size={18} color={COLORS.white} />}
              className="bg-accent-pink"
              testID="instant-call-submit"
            />
          </View>
          {initiateCall.isError && (
            <Text
              className="text-[13px] text-center mt-3"
              style={{ color: COLORS.destructive }}
              testID="instant-call-error"
            >
              {getErrorMessage(
                initiateCall.error,
                t("dashboard.failedToInitiate"),
                "call",
              )}
            </Text>
          )}
        </View>
      </Modal>
    </SafeAreaView>
  );
}

// --- Call Card Sub-component ---

function CallCard({ conversation }: { conversation: Conversation }) {
  const { t } = useTranslation();
  const statusKey = getCallStatusKey(conversation);
  const isAnswered = statusKey === "answered";
  const [expanded, setExpanded] = useState(false);
  const [canExpand, setCanExpand] = useState(false);

  const dateStr = useMemo(() => {
    try {
      const locale = getDateFnsLocale();
      const date = new Date(conversation.startedAt);
      const dayDiff = differenceInCalendarDays(new Date(), date);
      const time = format(date, "h:mm a", { locale });
      if (dayDiff === 0) return t("dashboard.todayAtTime", { time });
      if (dayDiff === 1) return t("dashboard.yesterdayAtTime", { time });
      return format(date, "d MMM", { locale }) + ` ${time}`;
    } catch {
      return t("dashboard.unknownDate");
    }
  }, [conversation.startedAt, t]);

  return (
    <View
      className="bg-white rounded-2xl p-4 mb-3"
      style={{
        borderWidth: 1,
        borderColor: COLORS.border,
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.04,
        shadowRadius: 3,
        elevation: 1,
      }}
    >
      <View className="flex-row items-center justify-between mb-2">
        <Text className="text-charcoal text-[14px] font-medium">{dateStr}</Text>
        <View
          className="rounded-full px-3 py-1"
          style={{
            backgroundColor: isAnswered ? COLORS.successBg : COLORS.warningBg,
          }}
        >
          <Text
            className="text-[12px] font-semibold"
            style={{ color: isAnswered ? COLORS.success : COLORS.warning }}
          >
            {t(`dashboard.${statusKey}`)}
          </Text>
        </View>
      </View>
      {conversation.summary ? (
        <View>
          <Text
            className="text-muted text-[14px] leading-5"
            numberOfLines={expanded ? undefined : 3}
          >
            {conversation.summary}
          </Text>
          {!canExpand && (
            <Text
              className="text-[14px] leading-5"
              style={{ position: "absolute", opacity: 0, left: 0, right: 0 }}
              onTextLayout={(e) => {
                if (e.nativeEvent.lines.length > 3) setCanExpand(true);
              }}
            >
              {conversation.summary}
            </Text>
          )}
          {canExpand && (
            <Pressable
              onPress={() => setExpanded((v) => !v)}
              hitSlop={8}
              className="mt-2 self-start"
            >
              <Text
                className="text-[14px] font-semibold"
                style={{ color: COLORS.sage }}
              >
                {expanded ? t("dashboard.showLess") : t("dashboard.showMore")}
              </Text>
            </Pressable>
          )}
        </View>
      ) : (
        <Text className="text-muted/60 text-[14px] italic">
          {t("dashboard.noSummary")}
        </Text>
      )}
    </View>
  );
}
