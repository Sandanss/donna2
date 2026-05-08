import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  FlatList,
  ActivityIndicator,
  TextInput,
  Dimensions,
  Platform,
  KeyboardAvoidingView,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Clock,
  Plus,
  Edit2,
  Check,
  X,
  Calendar,
} from "lucide-react-native";
import * as Haptics from "expo-haptics";
import {
  format,
  addDays,
  startOfWeek,
  isSameDay,
  startOfMonth,
  getDaysInMonth,
  addMonths,
  subMonths,
  addWeeks,
  subWeeks,
  startOfDay,
  getDay,
} from "date-fns";
import { useTranslation } from "react-i18next";
import { useFocusEffect } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { getDateFnsLocale } from "@/src/lib/dateFnsLocale";
import { COLORS } from "@/src/constants/theme";
import {
  useCurrentSenior,
  useSchedule,
  useUpdateSchedule,
  useReminders,
} from "@/src/hooks";
import { Button, Input, Modal, TimePickerField } from "@/src/components/ui";
import { getErrorMessage } from "@/src/lib/api";
import type { Reminder } from "@/src/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Frequency = "daily" | "recurring" | "one-time";

interface ScheduleItem {
  id?: string;
  title: string;
  frequency: Frequency;
  recurringDays?: number[]; // 0=Sun ... 6=Sat
  date?: string; // ISO for one-time
  time: string; // "9:00 AM"
  contextNotes?: string;
  reminderIds?: string[];
}

interface CallCardData {
  schedule: ScheduleItem;
  index: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// DAY_LETTERS and DAY_LABELS are now loaded from translations inside the component

function getScheduleForDate(date: Date, scheduleData: ScheduleItem[]): ScheduleItem[] {
  return scheduleData.filter((schedule) => {
    if (schedule.frequency === "daily") return true;
    if (schedule.frequency === "recurring") {
      return schedule.recurringDays?.includes(getDay(date));
    }
    if (schedule.frequency === "one-time" && schedule.date) {
      return isSameDay(new Date(schedule.date), date);
    }
    return false;
  });
}

function normalizeScheduleData(raw: any): ScheduleItem[] {
  // Handle various API response shapes
  if (!raw) return [];

  // If the API returns { schedule: [...] }
  if (Array.isArray(raw.schedule)) return raw.schedule;
  if (Array.isArray(raw.calls)) return raw.calls;
  if (Array.isArray(raw)) return raw;

  // Legacy shape: { time: "9:00 AM", days: ["Mon", "Tue"] }
  if (raw.time) {
    const dayMap: Record<string, number> = {
      Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
    };
    const recurringDays = (raw.days ?? []).map((d: string) => dayMap[d] ?? 0);
    return [{
      title: "Daily Call",
      frequency: recurringDays.length > 0 ? "recurring" : "daily",
      recurringDays,
      time: raw.time,
    }];
  }

  // Nested shape: { schedule: { time, days } }
  if (raw.schedule?.time) {
    return normalizeScheduleData(raw.schedule);
  }

  return [];
}

// ---------------------------------------------------------------------------
// Component: Schedule Screen
// ---------------------------------------------------------------------------

export default function ScheduleScreen() {
  const { t } = useTranslation();
  const dateFnsLocale = getDateFnsLocale();
  const DAY_LETTERS = t("schedule.dayLetters", { returnObjects: true }) as string[];
  const DAY_LABELS = t("schedule.dayLabels", { returnObjects: true }) as string[];
  const { senior, seniorId, isLoading: seniorLoading } = useCurrentSenior();
  const queryClient = useQueryClient();
  const { data: rawSchedule, isLoading: scheduleLoading } = useSchedule(seniorId);
  const updateSchedule = useUpdateSchedule(seniorId);
  const { data: reminders } = useReminders(seniorId);

  // Refresh schedule + reminders when the user enters this tab — voice
  // reminders write to seniors.preferred_call_times.schedule out-of-band.
  useFocusEffect(
    useCallback(() => {
      if (!seniorId) return;
      queryClient.invalidateQueries({ queryKey: ["schedule", seniorId] });
      queryClient.invalidateQueries({ queryKey: ["reminders", seniorId] });
    }, [queryClient, seniorId]),
  );

  const [selectedDate, setSelectedDate] = useState(startOfDay(new Date()));
  const [baseWeekDate, setBaseWeekDate] = useState(startOfWeek(new Date(), { weekStartsOn: 0 }));
  const [showMonthPicker, setShowMonthPicker] = useState(false);
  const [monthPickerDate, setMonthPickerDate] = useState(startOfMonth(new Date()));

  // Modal state
  const [modalVisible, setModalVisible] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [deleteConfirmIndex, setDeleteConfirmIndex] = useState<number | null>(null);

  // Edit form state
  const [formTitle, setFormTitle] = useState("Daily Call");
  const [formFrequency, setFormFrequency] = useState<Frequency>("daily");
  const [formDays, setFormDays] = useState<number[]>([]);
  const [formDate, setFormDate] = useState("");
  const [formTime, setFormTime] = useState("9:00 AM");
  const [formNotes, setFormNotes] = useState("");
  const [formReminderIds, setFormReminderIds] = useState<string[]>([]);
  const [recentlySavedTitle, setRecentlySavedTitle] = useState<string | null>(null);
  const listRef = useRef<FlatList<CallCardData>>(null);

  const seniorFirstName = senior?.name?.split(" ")[0] ?? "your loved one";
  const timeHelperText = senior?.name
    ? t("reminders.localTime", { name: seniorFirstName })
    : t("reminders.seniorLocalTime");

  // ---------------------------------------------------------------------------
  // Data
  // ---------------------------------------------------------------------------

  const scheduleItems = useMemo(() => normalizeScheduleData(rawSchedule), [rawSchedule]);

  const dailyItems = useMemo(
    () => getScheduleForDate(selectedDate, scheduleItems),
    [selectedDate, scheduleItems],
  );

  const weekDays = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(baseWeekDate, i)),
    [baseWeekDate],
  );

  // Build card data
  const cardData = useMemo<CallCardData[]>(() => {
    return dailyItems.map((schedule) => ({
      schedule,
      index: scheduleItems.indexOf(schedule),
    }));
  }, [dailyItems, scheduleItems]);

  useEffect(() => {
    if (!recentlySavedTitle) return;

    const savedIndex = cardData.findIndex(
      (item) => item.schedule.title === recentlySavedTitle,
    );
    if (savedIndex < 0) return;

    const scrollTimeout = setTimeout(() => {
      listRef.current?.scrollToIndex({
        index: savedIndex,
        animated: true,
        viewPosition: 0.5,
      });
      setRecentlySavedTitle(null);
    }, 100);

    return () => clearTimeout(scrollTimeout);
  }, [cardData, recentlySavedTitle]);

  // ---------------------------------------------------------------------------
  // Week navigation
  // ---------------------------------------------------------------------------

  const handlePrevWeek = useCallback(() => {
    Haptics.selectionAsync();
    setBaseWeekDate((prev) => subWeeks(prev, 1));
  }, []);

  const handleNextWeek = useCallback(() => {
    Haptics.selectionAsync();
    setBaseWeekDate((prev) => addWeeks(prev, 1));
  }, []);

  const handleSelectDate = useCallback(
    (date: Date) => {
      Haptics.selectionAsync();
      setSelectedDate(startOfDay(date));
      setShowMonthPicker(false);

      // Update base week to contain selected date
      const weekStart = startOfWeek(date, { weekStartsOn: 0 });
      setBaseWeekDate(weekStart);
    },
    [],
  );

  // ---------------------------------------------------------------------------
  // Month picker
  // ---------------------------------------------------------------------------

  const monthPickerDays = useMemo(() => {
    const firstDay = startOfMonth(monthPickerDate);
    const daysInMonth = getDaysInMonth(monthPickerDate);
    const startDayOfWeek = getDay(firstDay); // 0=Sun

    const cells: (Date | null)[] = [];
    // Leading empty cells
    for (let i = 0; i < startDayOfWeek; i++) cells.push(null);
    // Day cells
    for (let d = 1; d <= daysInMonth; d++) {
      cells.push(new Date(monthPickerDate.getFullYear(), monthPickerDate.getMonth(), d));
    }
    return cells;
  }, [monthPickerDate]);

  // ---------------------------------------------------------------------------
  // Add/Edit modal
  // ---------------------------------------------------------------------------

  const openAddModal = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setEditingIndex(null);
    setFormTitle("Daily Call");
    setFormFrequency("daily");
    setFormDays([]);
    setFormDate(format(selectedDate, "MM/dd/yyyy"));
    setFormTime("9:00 AM");
    setFormNotes("");
    setFormReminderIds([]);
    setModalVisible(true);
  }, [selectedDate]);

  const openEditModal = useCallback(
    (globalIndex: number) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      const item = scheduleItems[globalIndex];
      if (!item) return;

      setEditingIndex(globalIndex);
      setFormTitle(item.title || "Daily Call");
      setFormFrequency(item.frequency || "daily");
      setFormDays(item.recurringDays ?? []);
      setFormDate(item.date ? format(new Date(item.date), "MM/dd/yyyy") : "");
      setFormTime(item.time || "9:00 AM");
      setFormNotes(item.contextNotes ?? "");
      setFormReminderIds(item.reminderIds ?? []);
      setModalVisible(true);
    },
    [scheduleItems, t],
  );

  const handleSave = useCallback(async () => {
    const newItem: ScheduleItem = {
      title: formTitle,
      frequency: formFrequency,
      recurringDays: formFrequency === "recurring" ? formDays : undefined,
      date: formFrequency === "one-time" ? formDate : undefined,
      time: formTime,
      contextNotes: formNotes || undefined,
      reminderIds: formReminderIds.length > 0 ? formReminderIds : undefined,
    };

    let updated: ScheduleItem[];
    if (editingIndex !== null) {
      updated = scheduleItems.map((item, i) => (i === editingIndex ? newItem : item));
    } else {
      updated = [...scheduleItems, newItem];
    }

    try {
      await updateSchedule.mutateAsync({ schedule: updated });
      setModalVisible(false);
      setRecentlySavedTitle(newItem.title);
    } catch {
      console.error('[Schedule] Save failed');
    }
  }, [
    formTitle,
    formFrequency,
    formDays,
    formDate,
    formTime,
    formNotes,
    formReminderIds,
    editingIndex,
    scheduleItems,
    updateSchedule,
  ]);

  const handleDelete = useCallback(async () => {
    if (deleteConfirmIndex === null) return;
    const updated = scheduleItems.filter((_, i) => i !== deleteConfirmIndex);
    try {
      await updateSchedule.mutateAsync({ schedule: updated });
      setDeleteConfirmIndex(null);
      setModalVisible(false);
    } catch {
      // Error handled by react-query
    }
  }, [deleteConfirmIndex, scheduleItems, updateSchedule]);

  const toggleFormDay = useCallback((dayIndex: number) => {
    setFormDays((prev) =>
      prev.includes(dayIndex) ? prev.filter((d) => d !== dayIndex) : [...prev, dayIndex],
    );
  }, []);

  const toggleFormReminder = useCallback((reminderId: string) => {
    setFormReminderIds((prev) =>
      prev.includes(reminderId) ? prev.filter((r) => r !== reminderId) : [...prev, reminderId],
    );
  }, []);

  // ---------------------------------------------------------------------------
  // Loading state
  // ---------------------------------------------------------------------------

  if (seniorLoading) {
    return (
      <SafeAreaView className="flex-1 bg-cream" edges={["top"]}>
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" color={COLORS.sage} />
        </View>
      </SafeAreaView>
    );
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <View className="flex-1 bg-cream">
      {/* ================================================================= */}
      {/* SAGE HEADER                                                       */}
      {/* ================================================================= */}
      <View
        className="bg-sage pt-16 pb-6 px-6"
        style={{ borderBottomLeftRadius: 32, borderBottomRightRadius: 32 }}
      >
        {/* Day name */}
        <Text
          style={{ fontFamily: "PlayfairDisplay_400Regular" }}
          className="text-[40px] text-cream leading-[48px]"
        >
          {format(selectedDate, "EEEE", { locale: dateFnsLocale }).replace(/^\w/, (c) => c.toUpperCase())}
        </Text>

        {/* Month/year toggle */}
        <Pressable
          onPress={() => {
            Haptics.selectionAsync();
            setMonthPickerDate(startOfMonth(selectedDate));
            setShowMonthPicker(!showMonthPicker);
          }}
          className="flex-row items-center mt-1 min-h-[48px]"
          accessibilityRole="button"
          accessibilityLabel={`${format(selectedDate, "MMMM yyyy", { locale: dateFnsLocale })}`}
        >
          <Text className="text-[13px] uppercase tracking-widest text-cream/80">
            {format(selectedDate, "MMM yyyy", { locale: dateFnsLocale })}
          </Text>
          <ChevronDown
            size={14}
            color="rgba(253,252,248,0.6)"
            style={{ marginLeft: 4 }}
          />
        </Pressable>

        {/* Week row */}
        <View className="flex-row items-center mt-4">
          <Pressable
            onPress={handlePrevWeek}
            className="min-w-[44px] min-h-[48px] items-center justify-center"
            accessibilityRole="button"
            accessibilityLabel={t("schedule.previousWeek")}
          >
            <ChevronLeft size={20} color="rgba(253,252,248,0.6)" />
          </Pressable>

          <View className="flex-1 flex-row justify-between">
            {weekDays.map((date) => {
              const isSelected = isSameDay(date, selectedDate);
              const isToday = isSameDay(date, new Date());
              return (
                <Pressable
                  key={date.toISOString()}
                  onPress={() => handleSelectDate(date)}
                  className="items-center min-w-[40px] min-h-[56px] justify-center"
                  accessibilityRole="button"
                  accessibilityLabel={format(date, "EEEE, MMMM d", { locale: dateFnsLocale })}
                  accessibilityState={{ selected: isSelected }}
                >
                  <Text
                    className={`text-[11px] uppercase ${
                      isSelected ? "text-cream font-semibold" : "text-cream/60"
                    }`}
                  >
                    {format(date, "EEEEE", { locale: dateFnsLocale })}
                  </Text>
                  <Text
                    style={
                      isSelected
                        ? { fontFamily: "PlayfairDisplay_600SemiBold" }
                        : { fontFamily: "PlayfairDisplay_400Regular" }
                    }
                    className={`text-[20px] mt-0.5 ${
                      isSelected ? "text-cream" : "text-cream/60"
                    }`}
                  >
                    {format(date, "d")}
                  </Text>
                  {isSelected && (
                    <View
                      className="mt-1 rounded-full"
                      style={{
                        width: 16,
                        height: 3,
                        borderRadius: 1.5,
                        backgroundColor: COLORS.accentPink,
                      }}
                    />
                  )}
                  {!isSelected && isToday && (
                    <View
                      className="mt-1 rounded-full"
                      style={{
                        width: 4,
                        height: 4,
                        borderRadius: 2,
                        backgroundColor: "rgba(253,252,248,0.4)",
                      }}
                    />
                  )}
                </Pressable>
              );
            })}
          </View>

          <Pressable
            onPress={handleNextWeek}
            className="min-w-[44px] min-h-[48px] items-center justify-center"
            accessibilityRole="button"
            accessibilityLabel={t("schedule.nextWeek")}
          >
            <ChevronRight size={20} color="rgba(253,252,248,0.6)" />
          </Pressable>
        </View>
      </View>

      {/* ================================================================= */}
      {/* MONTH PICKER OVERLAY                                              */}
      {/* ================================================================= */}
      {showMonthPicker && (
        <View
          className="absolute left-4 right-4 z-50"
          style={{
            top: Platform.OS === "ios" ? 210 : 190,
            backgroundColor: COLORS.sageDark,
            borderRadius: 24,
            padding: 20,
            shadowColor: "#000",
            shadowOffset: { width: 0, height: 8 },
            shadowOpacity: 0.25,
            shadowRadius: 16,
            elevation: 10,
          }}
        >
          {/* Month nav */}
          <View className="flex-row items-center justify-between mb-4">
            <Pressable
              onPress={() => {
                Haptics.selectionAsync();
                setMonthPickerDate((prev) => subMonths(prev, 1));
              }}
              className="min-w-[48px] min-h-[48px] items-center justify-center"
              accessibilityRole="button"
              accessibilityLabel={t("schedule.previousMonth")}
            >
              <ChevronLeft size={20} color={COLORS.cream} />
            </Pressable>
            <Text
              style={{ fontFamily: "PlayfairDisplay_500Medium" }}
              className="text-cream text-[18px]"
            >
              {format(monthPickerDate, "MMMM yyyy", { locale: dateFnsLocale })}
            </Text>
            <Pressable
              onPress={() => {
                Haptics.selectionAsync();
                setMonthPickerDate((prev) => addMonths(prev, 1));
              }}
              className="min-w-[48px] min-h-[48px] items-center justify-center"
              accessibilityRole="button"
              accessibilityLabel={t("schedule.nextMonth")}
            >
              <ChevronRight size={20} color={COLORS.cream} />
            </Pressable>
          </View>

          {/* Day-of-week headers */}
          <View className="flex-row mb-2">
            {DAY_LETTERS.map((letter, i) => (
              <View key={i} className="flex-1 items-center">
                <Text className="text-[11px] text-cream/50 uppercase">{letter}</Text>
              </View>
            ))}
          </View>

          {/* Day grid */}
          <View className="flex-row flex-wrap">
            {monthPickerDays.map((date, i) => {
              if (!date) {
                return <View key={`empty-${i}`} style={{ width: "14.28%", height: 40 }} />;
              }
              const isSelected = isSameDay(date, selectedDate);
              const isToday = isSameDay(date, new Date());
              return (
                <Pressable
                  key={date.toISOString()}
                  onPress={() => handleSelectDate(date)}
                  style={{ width: "14.28%", height: 40 }}
                  className="items-center justify-center"
                  accessibilityRole="button"
                  accessibilityLabel={format(date, "MMMM d, yyyy", { locale: dateFnsLocale })}
                >
                  <View
                    className="items-center justify-center"
                    style={[
                      { width: 32, height: 32, borderRadius: 16 },
                      isSelected && { backgroundColor: COLORS.accentPink },
                      !isSelected && isToday && {
                        borderWidth: 1,
                        borderColor: "rgba(253,252,248,0.4)",
                      },
                    ]}
                  >
                    <Text
                      className={`text-[14px] ${
                        isSelected ? "text-white font-semibold" : "text-cream/80"
                      }`}
                    >
                      {format(date, "d")}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
          </View>
        </View>
      )}

      {/* Dismiss overlay backdrop */}
      {showMonthPicker && (
        <Pressable
          className="absolute inset-0 z-40"
          onPress={() => setShowMonthPicker(false)}
          accessibilityLabel={t("common.done")}
        />
      )}

      {/* ================================================================= */}
      {/* SCHEDULE LIST                                                     */}
      {/* ================================================================= */}
      <View className="flex-1 px-6 pt-6">
        <Text className="text-[13px] uppercase tracking-widest text-muted mb-4 font-medium">
          {format(selectedDate, "EEEE, MMM d", { locale: dateFnsLocale }).replace(/^\w/, (c) => c.toUpperCase())}
        </Text>

        {scheduleLoading ? (
          <View className="flex-1 items-center justify-center">
            <ActivityIndicator size="large" color={COLORS.sage} />
          </View>
        ) : cardData.length === 0 ? (
          <View className="flex-1 items-center justify-center pb-20">
            <Calendar size={40} color={COLORS.muted} style={{ opacity: 0.4 }} />
            <Text className="text-muted text-[16px] mt-4 text-center">
              {t("schedule.noCallsForDay")}
            </Text>
            <Text className="text-muted/60 text-[14px] mt-2 text-center">
              {t("schedule.tapToAdd", { name: seniorFirstName })}
            </Text>
          </View>
        ) : (
          <FlatList
            ref={listRef}
            data={cardData}
            keyExtractor={(item, i) => `${item.schedule.title}-${i}`}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: 120 }}
            onScrollToIndexFailed={() => {
              listRef.current?.scrollToEnd({ animated: true });
            }}
            renderItem={({ item }) => (
              <ScheduleCallCard
                data={item}
                reminders={reminders ?? []}
                onEdit={() => openEditModal(item.index)}
              />
            )}
          />
        )}
      </View>

      {/* ================================================================= */}
      {/* FLOATING ADD BUTTON                                               */}
      {/* ================================================================= */}
      <Pressable
        onPress={openAddModal}
        className="absolute right-6 bottom-28 w-14 h-14 rounded-full items-center justify-center"
        style={{
          backgroundColor: COLORS.accentPink,
          shadowColor: COLORS.accentPink,
          shadowOffset: { width: 0, height: 4 },
          shadowOpacity: 0.35,
          shadowRadius: 8,
          elevation: 5,
        }}
        accessibilityRole="button"
        accessibilityLabel={t("schedule.addNewCall")}
      >
        <Plus size={24} color={COLORS.white} />
      </Pressable>

      {/* ================================================================= */}
      {/* ADD / EDIT CALL MODAL                                             */}
      {/* ================================================================= */}
      <Modal
        visible={modalVisible}
        onClose={() => setModalVisible(false)}
        title={editingIndex !== null ? t("schedule.editCall") : t("schedule.addCall")}
      >
        <View className="pb-6">
          {/* Title */}
          <View className="mb-5">
            <Input
              label={t("schedule.callTitle")}
              placeholder={t("schedule.callTitlePlaceholder")}
              value={formTitle}
              onChangeText={setFormTitle}
              testID="call-title-input"
            />
          </View>

          {/* Frequency */}
          <View className="mb-5">
            <Text className="text-[13px] font-medium text-muted mb-2 uppercase tracking-wider">
              {t("schedule.frequency")}
            </Text>
            <View className="flex-row gap-2">
              {(
                [
                  { key: "daily", label: t("schedule.daily") },
                  { key: "recurring", label: t("schedule.recurring") },
                  { key: "one-time", label: t("schedule.oneTime") },
                ] as const
              ).map(({ key, label }) => (
                <Pressable
                  key={key}
                  onPress={() => setFormFrequency(key)}
                  className={`flex-1 py-2.5 rounded-xl items-center border ${
                    formFrequency === key
                      ? "bg-sage border-sage"
                      : "bg-white border-charcoal/10"
                  }`}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: formFrequency === key }}
                  accessibilityLabel={label}
                >
                  <Text
                    className={`text-[13px] font-medium ${
                      formFrequency === key ? "text-white" : "text-charcoal"
                    }`}
                  >
                    {label}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>

          {/* Day picker for recurring */}
          {formFrequency === "recurring" && (
            <View className="mb-5">
              <Text className="text-[13px] font-medium text-muted mb-2 uppercase tracking-wider">
                {t("schedule.selectDays")}
              </Text>
              <View className="flex-row gap-1.5">
                {DAY_LABELS.map((day, dayIndex) => (
                  <Pressable
                    key={day}
                    onPress={() => toggleFormDay(dayIndex)}
                    className={`flex-1 py-2.5 rounded-xl items-center ${
                      formDays.includes(dayIndex) ? "bg-sage" : "bg-beige"
                    }`}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: formDays.includes(dayIndex) }}
                    accessibilityLabel={day}
                  >
                    <Text
                      className={`text-[12px] font-medium ${
                        formDays.includes(dayIndex) ? "text-white" : "text-muted"
                      }`}
                    >
                      {day}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>
          )}

          {/* Date input for one-time */}
          {formFrequency === "one-time" && (
            <View className="mb-5">
              <Input
                label={t("schedule.date")}
                placeholder="MM/DD/YYYY"
                value={formDate}
                onChangeText={setFormDate}
                keyboardType="numbers-and-punctuation"
              />
            </View>
          )}

          {/* Time picker */}
          <View className="mb-5">
            <TimePickerField
              value={formTime}
              onChange={setFormTime}
              helperText={timeHelperText}
              accessibilityLabel="Select call time"
              testID="call-time-picker"
            />
          </View>

          {/* Context notes */}
          <View className="mb-5">
            <Text className="text-[13px] font-medium text-muted mb-1.5 uppercase tracking-wider">
              {t("schedule.contextNotes")}
            </Text>
            <TextInput
              className="bg-beige rounded-2xl p-4 text-charcoal text-[15px] min-h-[80px]"
              placeholder={t("schedule.contextNotesPlaceholder", { name: seniorFirstName })}
              placeholderTextColor={COLORS.muted}
              multiline
              textAlignVertical="top"
              value={formNotes}
              onChangeText={setFormNotes}
              accessibilityLabel="Context notes"
              testID="call-context-notes-input"
              returnKeyType="done"
              blurOnSubmit
            />
          </View>

          {/* Reminder checkboxes */}
          {reminders && reminders.length > 0 && (
            <View className="mb-5">
              <Text className="text-[13px] font-medium text-muted mb-2 uppercase tracking-wider">
                {t("schedule.includeReminders")}
              </Text>
              <View className="gap-2">
                {reminders.map((reminder) => {
                  const isChecked = formReminderIds.includes(reminder.id);
                  return (
                    <Pressable
                      key={reminder.id}
                      onPress={() => toggleFormReminder(reminder.id)}
                      className="flex-row items-center gap-3 py-2"
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: isChecked }}
                      accessibilityLabel={reminder.title}
                    >
                      <View
                        className={`w-5 h-5 rounded-md border items-center justify-center ${
                          isChecked
                            ? "bg-sage border-sage"
                            : "bg-white border-charcoal/20"
                        }`}
                      >
                        {isChecked && <Check size={14} color={COLORS.white} />}
                      </View>
                      <Text className="text-[14px] text-charcoal flex-1">
                        {reminder.title}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          )}

          {/* Action buttons */}
          <View className="gap-3 mt-2">
            <Button
              title={editingIndex !== null ? t("common.save") : t("schedule.addCall")}
              onPress={handleSave}
              loading={updateSchedule.isPending}
              disabled={!formTitle || !formTime || updateSchedule.isPending}
            />
            {editingIndex !== null && (
              <Button
                title={t("schedule.deleteCall")}
                onPress={() => {
                  setModalVisible(false);
                  setDeleteConfirmIndex(editingIndex);
                }}
                variant="destructive"
                disabled={updateSchedule.isPending}
              />
            )}
          </View>

          {updateSchedule.isError && (
            <Text className="text-[13px] text-center mt-3" style={{ color: COLORS.destructive }}>
              {getErrorMessage(
                updateSchedule.error,
                t("schedule.failedToSave"),
                "save",
              )}
            </Text>
          )}
        </View>
      </Modal>

      {/* ================================================================= */}
      {/* DELETE CONFIRMATION MODAL                                         */}
      {/* ================================================================= */}
      <Modal
        visible={deleteConfirmIndex !== null}
        onClose={() => setDeleteConfirmIndex(null)}
        title={t("schedule.deleteCall")}
        variant="centered"
      >
        <Text className="text-[15px] text-muted mb-6">
          {t("schedule.deleteCallMessage")}
        </Text>
        <View className="gap-3">
          <Button
            title={t("common.delete")}
            onPress={handleDelete}
            variant="destructive"
            loading={updateSchedule.isPending}
          />
          <Button
            title={t("common.cancel")}
            onPress={() => setDeleteConfirmIndex(null)}
            variant="ghost"
          />
        </View>
      </Modal>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Sub-component: Schedule Call Card
// ---------------------------------------------------------------------------

function ScheduleCallCard({
  data,
  reminders,
  onEdit,
}: {
  data: CallCardData;
  reminders: Reminder[];
  onEdit: () => void;
}) {
  const { t } = useTranslation();
  const { schedule } = data;
  const displayTitle = schedule.title;

  // Get reminder titles for this call
  const callReminders = useMemo(() => {
    if (!schedule.reminderIds || schedule.reminderIds.length === 0) return [];
    return reminders.filter((r) => schedule.reminderIds!.includes(r.id));
  }, [schedule.reminderIds, reminders]);

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
      {/* Header */}
      <View className="flex-row items-center justify-between mb-2">
        <Text className="text-[16px] font-semibold text-charcoal flex-1" numberOfLines={1}>
          {displayTitle}
        </Text>
        <Pressable
          onPress={onEdit}
          className="min-w-[44px] min-h-[44px] items-center justify-center"
          accessibilityRole="button"
          accessibilityLabel={`${t("schedule.editCall")} ${displayTitle}`}
        >
          <Edit2 size={16} color={COLORS.muted} />
        </Pressable>
      </View>

      {/* Time */}
      <View className="flex-row items-center mb-2">
        <Clock size={14} color={COLORS.sage} />
        <Text className="text-[14px] text-charcoal font-medium ml-1.5">
          {schedule.time}
        </Text>
        {schedule.frequency !== "one-time" && (
          <View className="bg-beige rounded-full px-2 py-0.5 ml-2">
            <Text className="text-[11px] text-muted capitalize">
              {schedule.frequency === "daily"
                ? t("schedule.everyDay")
                : schedule.recurringDays
                    ?.map((d) => (t("schedule.dayLabels", { returnObjects: true }) as string[])[d])
                    .join(", ") ?? t("schedule.recurring")}
            </Text>
          </View>
        )}
      </View>

      {/* Context notes */}
      {schedule.contextNotes && (
        <Text className="text-[13px] text-muted mb-2 leading-[18px]">
          {schedule.contextNotes}
        </Text>
      )}

      {/* Reminders */}
      {callReminders.length > 0 && (
        <View className="mt-1">
          {callReminders.map((reminder) => (
            <View key={reminder.id} className="flex-row items-center mb-1">
              <View
                className="w-1.5 h-1.5 rounded-full mr-2"
                style={{ backgroundColor: COLORS.accentPink }}
              />
              <Text className="text-[13px] text-muted">{reminder.title}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}
