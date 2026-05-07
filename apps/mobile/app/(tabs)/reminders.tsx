import { useState, useCallback, useMemo } from "react";
import {
  View,
  Text,
  Pressable,
  TextInput,
  FlatList,
  RefreshControl,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Edit2, Trash2, Plus, Bell, Phone } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { COLORS } from "@/src/constants/theme";
import { getErrorMessage } from "@/src/lib/api";
import {
  cronExpressionFromTime,
  getReminderTimeLabel,
  resolveSeniorTimezone,
  timeStringToUtcIso,
} from "@/src/lib/timezone";
import {
  useCurrentSenior,
  useReminders,
  useCreateReminder,
  useUpdateReminder,
  useDeleteReminder,
} from "@/src/hooks";
import { Button, DatePickerField, Input, Modal, TimePickerField } from "@/src/components/ui";
import type { Reminder } from "@/src/types";

// --- Types ---

type ReminderFormData = {
  title: string;
  description: string;
  faqs: string;
  date: string; // "YYYY-MM-DD"
  time: string;
  isRecurring: boolean;
};

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const EMPTY_FORM: ReminderFormData = {
  title: "",
  description: "",
  faqs: "",
  date: todayIso(),
  time: "9:00 AM",
  isRecurring: true,
};

// --- Helpers ---

function getScheduleLabel(reminder: Reminder, timezone: string, t: (key: string, opts?: Record<string, unknown>) => string): string {
  if (!reminder.scheduledTime) return t("reminders.notScheduled");
  const timeStr = getReminderTimeLabel(reminder, timezone);
  return reminder.isRecurring ? t("reminders.dailyAt", { time: timeStr }) : timeStr;
}

// --- Component ---

export default function RemindersScreen() {
  const { t } = useTranslation();
  const { senior, seniorId, isLoading: seniorLoading } = useCurrentSenior();
  const {
    data: reminders,
    isLoading: remindersLoading,
    refetch: refetchReminders,
  } = useReminders(seniorId);
  const createReminder = useCreateReminder(seniorId);
  const updateReminder = useUpdateReminder(seniorId);
  const deleteReminder = useDeleteReminder(seniorId);

  const [refreshing, setRefreshing] = useState(false);
  const [formModalVisible, setFormModalVisible] = useState(false);
  const [deleteModalVisible, setDeleteModalVisible] = useState(false);
  const [editingReminder, setEditingReminder] = useState<Reminder | null>(null);
  const [deletingReminder, setDeletingReminder] = useState<Reminder | null>(null);
  const [form, setForm] = useState<ReminderFormData>(EMPTY_FORM);

  const seniorFirstName = useMemo(
    () => (senior?.name ?? "your loved one").split(" ")[0],
    [senior?.name],
  );
  const seniorTimezone = useMemo(() => resolveSeniorTimezone(senior), [senior]);
  const timeHelperText = senior?.name
    ? t("reminders.localTime", { name: seniorFirstName })
    : t("reminders.seniorLocalTime");

  const activeReminders = useMemo(
    () => (reminders ?? []).filter((r) => r.isActive),
    [reminders],
  );

  // --- Handlers ---

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refetchReminders();
    setRefreshing(false);
  }, [refetchReminders]);

  const openAddModal = useCallback(() => {
    setEditingReminder(null);
    setForm(EMPTY_FORM);
    setFormModalVisible(true);
  }, []);

  const openEditModal = useCallback((reminder: Reminder) => {
    setEditingReminder(reminder);
    let editDate = todayIso();
    if (reminder.scheduledTime) {
      const d = new Date(reminder.scheduledTime);
      editDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    }
    setForm({
      title: reminder.title,
      description: reminder.description ?? "",
      faqs: "",
      date: editDate,
      time: reminder.scheduledTime
        ? getReminderTimeLabel(reminder, seniorTimezone)
        : "9:00 AM",
      isRecurring: reminder.isRecurring ?? true,
    });
    setFormModalVisible(true);
  }, [seniorTimezone]);

  const closeFormModal = useCallback(() => {
    setFormModalVisible(false);
    setEditingReminder(null);
    setForm(EMPTY_FORM);
  }, []);

  const openDeleteModal = useCallback((reminder: Reminder) => {
    setDeletingReminder(reminder);
    setDeleteModalVisible(true);
  }, []);

  const closeDeleteModal = useCallback(() => {
    setDeleteModalVisible(false);
    setDeletingReminder(null);
  }, []);

  const handleSave = useCallback(async () => {
    const trimmedTitle = form.title.trim();
    if (!trimmedTitle) return;

    const description = [form.description.trim(), form.faqs.trim()]
      .filter(Boolean)
      .join("\n\nFAQs:\n");
    const [year, month, day] = form.date.split("-").map(Number);
    const selectedDate = new Date(year, month - 1, day);
    const scheduledTime = timeStringToUtcIso(form.time, seniorTimezone, selectedDate);
    const cronExpression = form.isRecurring
      ? cronExpressionFromTime(form.time)
      : undefined;

    try {
      if (editingReminder) {
        await updateReminder.mutateAsync({
          id: editingReminder.id,
          data: {
            title: trimmedTitle,
            description: description || undefined,
            isRecurring: form.isRecurring,
            scheduledTime,
            cronExpression,
          },
        });
      } else {
        await createReminder.mutateAsync({
          type: "custom",
          title: trimmedTitle,
          description: description || undefined,
          isRecurring: form.isRecurring,
          isActive: true,
          scheduledTime,
          cronExpression,
        });
      }
      closeFormModal();
    } catch {
      // Error handled by react-query
    }
  }, [form, seniorTimezone, editingReminder, createReminder, updateReminder, closeFormModal]);

  const handleDelete = useCallback(async () => {
    if (!deletingReminder) return;
    try {
      await deleteReminder.mutateAsync(deletingReminder.id);
      closeDeleteModal();
    } catch {
      // Error handled by react-query
    }
  }, [deletingReminder, deleteReminder, closeDeleteModal]);

  const isSaving = createReminder.isPending || updateReminder.isPending;
  const canSave = form.title.trim().length > 0 && !isSaving;

  // --- Loading state ---

  if (seniorLoading) {
    return (
      <SafeAreaView className="flex-1 bg-cream">
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" color={COLORS.sage} />
        </View>
      </SafeAreaView>
    );
  }

  // --- Render ---

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={["top"]}>
      {/* Header */}
      <View className="px-6 pt-4 pb-2">
        <Text className="text-[28px] font-semibold text-charcoal">
          {t("reminders.title")}
        </Text>
        <Text className="text-[15px] text-muted mt-1">
          {t("reminders.subtitle", { name: seniorFirstName })}
        </Text>
      </View>

      {/* Reminder List */}
      {remindersLoading ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" color={COLORS.sage} />
        </View>
      ) : (
        <FlatList
          data={activeReminders}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: 120 }}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={COLORS.sage}
            />
          }
          ListHeaderComponent={
            <View className="mt-4">
              {/* Add New Reminder Button */}
              <Button
                title={t("reminders.addNew")}
                onPress={openAddModal}
                icon={<Plus size={18} color={COLORS.white} />}
                className="mb-4"
              />
            </View>
          }
          ListEmptyComponent={
            <View
              className="bg-white rounded-2xl p-6 items-center mt-2"
              style={{ borderWidth: 1, borderColor: COLORS.border }}
            >
              <Bell size={32} color={COLORS.muted} />
              <Text className="text-muted text-[15px] mt-3 text-center">
                {t("reminders.noReminders", { name: seniorFirstName })}
              </Text>
            </View>
          }
          renderItem={({ item }) => (
            <ReminderCard
              reminder={item}
              timezone={seniorTimezone}
              onEdit={openEditModal}
              onDelete={openDeleteModal}
            />
          )}
        />
      )}

      {/* Add / Edit Reminder Modal */}
      <Modal
        visible={formModalVisible}
        onClose={closeFormModal}
        title={editingReminder ? t("reminders.editReminder") : t("reminders.addReminder")}
        variant="bottom-sheet"
      >
        <View className="pb-6">
          <View className="mb-4">
            <Input
              label={t("reminders.titleLabel")}
              placeholder={t("reminders.titlePlaceholder")}
              value={form.title}
              onChangeText={(text) =>
                setForm((prev) => ({ ...prev, title: text }))
              }
              autoFocus
            />
          </View>

          <View className="mb-4">
            <Text className="text-[13px] font-medium text-muted mb-1.5 uppercase tracking-wider">
              {t("reminders.description")}
            </Text>
            <TextInput
              className="w-full bg-white px-4 py-3.5 rounded-2xl border border-charcoal/10 text-[15px] text-charcoal"
              placeholder={t("reminders.descriptionPlaceholder")}
              placeholderTextColor={COLORS.muted}
              multiline
              textAlignVertical="top"
              style={{ minHeight: 80 }}
              value={form.description}
              onChangeText={(text) =>
                setForm((prev) => ({ ...prev, description: text }))
              }
              accessibilityLabel={t("reminders.description")}
            />
          </View>

          <View className="mb-5">
            <Text className="text-[13px] font-medium text-muted mb-1.5 uppercase tracking-wider">
              {t("reminders.faqs")}
            </Text>
            <TextInput
              className="w-full bg-white px-4 py-3.5 rounded-2xl border border-charcoal/10 text-[15px] text-charcoal"
              placeholder={t("reminders.faqsPlaceholder")}
              placeholderTextColor={COLORS.muted}
              multiline
              textAlignVertical="top"
              style={{ minHeight: 80 }}
              value={form.faqs}
              onChangeText={(text) =>
                setForm((prev) => ({ ...prev, faqs: text }))
              }
              accessibilityLabel={t("reminders.faqs")}
            />
          </View>

          {/* Date picker */}
          <View className="mb-4">
            <DatePickerField
              value={form.date}
              onChange={(date) => setForm((prev) => ({ ...prev, date }))}
              helperText={timeHelperText}
              accessibilityLabel="Select reminder date"
              testID="reminder-date-picker"
            />
          </View>

          {/* Time picker */}
          <View className="mb-4">
            <TimePickerField
              value={form.time}
              onChange={(time) => setForm((prev) => ({ ...prev, time }))}
              helperText={timeHelperText}
              accessibilityLabel="Select reminder time"
              testID="reminder-time-picker"
            />
          </View>

          {/* Recurring toggle */}
          <View className="mb-5">
            <Text className="text-[13px] font-medium text-muted mb-2 uppercase tracking-wider">
              {t("reminders.frequency")}
            </Text>
            <View className="flex-row gap-2">
              <Pressable
                onPress={() => setForm((prev) => ({ ...prev, isRecurring: true }))}
                className={`flex-1 py-2.5 rounded-xl items-center border ${
                  form.isRecurring ? "bg-sage border-sage" : "bg-white border-charcoal/10"
                }`}
                accessibilityRole="radio"
                accessibilityState={{ selected: form.isRecurring }}
                accessibilityLabel={t("reminders.daily")}
              >
                <Text className={`text-[13px] font-medium ${form.isRecurring ? "text-white" : "text-charcoal"}`}>
                  {t("reminders.daily")}
                </Text>
              </Pressable>
              <Pressable
                onPress={() => setForm((prev) => ({ ...prev, isRecurring: false }))}
                className={`flex-1 py-2.5 rounded-xl items-center border ${
                  !form.isRecurring ? "bg-sage border-sage" : "bg-white border-charcoal/10"
                }`}
                accessibilityRole="radio"
                accessibilityState={{ selected: !form.isRecurring }}
                accessibilityLabel={t("reminders.oneTime")}
              >
                <Text className={`text-[13px] font-medium ${!form.isRecurring ? "text-white" : "text-charcoal"}`}>
                  {t("reminders.oneTime")}
                </Text>
              </Pressable>
            </View>
          </View>

          {/* Tip box */}
          <View className="bg-beige rounded-2xl p-4 mb-5">
            <Text className="text-muted text-[13px] leading-5">
              {t("reminders.tip")}
            </Text>
          </View>

          <Button
            title={editingReminder ? t("common.save") : t("reminders.addReminder")}
            onPress={handleSave}
            disabled={!canSave}
            loading={isSaving}
          />

          {(createReminder.isError || updateReminder.isError) && (
            <Text className="text-[13px] text-center mt-3" style={{ color: COLORS.destructive }}>
              {getErrorMessage(
                createReminder.error ?? updateReminder.error,
                t("common.unexpectedError"),
                "save",
              )}
            </Text>
          )}
        </View>
      </Modal>

      {/* Delete Confirmation Modal */}
      <Modal
        visible={deleteModalVisible}
        onClose={closeDeleteModal}
        title={t("reminders.deleteTitle")}
        variant="centered"
      >
        <Text className="text-muted text-[15px] mb-5 leading-5">
          {t("reminders.deleteMessage", { title: deletingReminder?.title, name: seniorFirstName })}
        </Text>

        <View className="gap-3">
          <Button
            title={t("reminders.deleteButton")}
            onPress={handleDelete}
            variant="destructive"
            loading={deleteReminder.isPending}
            disabled={deleteReminder.isPending}
            className="bg-accent-pink"
          />
          <Button
            title={t("common.cancel")}
            onPress={closeDeleteModal}
            variant="secondary"
            disabled={deleteReminder.isPending}
          />
        </View>

        {deleteReminder.isError && (
          <Text className="text-[13px] text-center mt-3" style={{ color: COLORS.destructive }}>
            {getErrorMessage(
              deleteReminder.error,
              t("reminders.failedToDelete"),
              "delete",
            )}
          </Text>
        )}
      </Modal>
    </SafeAreaView>
  );
}

// --- Reminder Card Sub-component ---

function ReminderCard({
  reminder,
  timezone,
  onEdit,
  onDelete,
}: {
  reminder: Reminder;
  timezone: string;
  onEdit: (r: Reminder) => void;
  onDelete: (r: Reminder) => void;
}) {
  const { t } = useTranslation();
  const scheduleLabel = useMemo(
    () => getScheduleLabel(reminder, timezone, t),
    [reminder, timezone, t],
  );

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
      <View className="flex-row items-center justify-between">
        {/* Title + Badge */}
        <View className="flex-1 mr-3">
          <Text
            className="text-[16px] font-semibold text-charcoal"
            numberOfLines={2}
          >
            {reminder.title}
          </Text>
          <View className="flex-row flex-wrap mt-2 gap-1.5">
            <View className="bg-beige rounded-full px-3 py-1">
              <Text className="text-muted text-[12px] font-medium">
                {scheduleLabel}
              </Text>
            </View>
            {reminder.createdVia === "voice" && (
              <View
                className="rounded-full px-3 py-1 flex-row items-center"
                style={{ backgroundColor: COLORS.sage }}
              >
                <Phone size={11} color={COLORS.white} />
                <Text className="text-white text-[12px] font-medium ml-1">
                  {t("reminders.createdViaCall")}
                </Text>
              </View>
            )}
          </View>
        </View>

        {/* Action Buttons */}
        <View className="flex-row items-center gap-1">
          <Pressable
            className="w-12 h-12 items-center justify-center rounded-xl"
            onPress={() => onEdit(reminder)}
            accessibilityRole="button"
            accessibilityLabel={`Edit ${reminder.title}`}
            hitSlop={4}
          >
            <Edit2 size={18} color={COLORS.muted} />
          </Pressable>
          <Pressable
            className="w-12 h-12 items-center justify-center rounded-xl"
            onPress={() => onDelete(reminder)}
            accessibilityRole="button"
            accessibilityLabel={`Delete ${reminder.title}`}
            hitSlop={4}
          >
            <Trash2 size={18} color={COLORS.accentPink} />
          </Pressable>
        </View>
      </View>

      {/* Description preview */}
      {reminder.description && (
        <Text
          className="text-muted text-[14px] mt-2 leading-5"
          numberOfLines={2}
        >
          {reminder.description}
        </Text>
      )}
    </View>
  );
}
