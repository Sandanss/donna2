import { useMemo, useRef, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import DateTimePicker, {
  type DateTimePickerEvent,
} from "@react-native-community/datetimepicker";
import { ChevronDown, Clock } from "lucide-react-native";
import { COLORS } from "@/src/constants/theme";
import {
  dateFromTimeString,
  formatTimeFromDate,
} from "@/src/lib/timezone";

type TimePickerFieldProps = {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  helperText?: string;
  accessibilityLabel?: string;
  testID?: string;
};

export function TimePickerField({
  label = "Time",
  value,
  onChange,
  helperText,
  accessibilityLabel = "Select time",
  testID,
}: TimePickerFieldProps) {
  const [showPicker, setShowPicker] = useState(false);
  const baseDate = useMemo(() => dateFromTimeString(value), [value]);

  // On iOS spinner, keep a local Date state so the picker visually follows
  // the user's scroll without triggering parent re-renders.
  const [iosPickerDate, setIosPickerDate] = useState<Date>(baseDate);

  // Sync local iOS date when the parent value changes (e.g. opening picker again)
  const prevValueRef = useRef(value);
  if (prevValueRef.current !== value) {
    prevValueRef.current = value;
    setIosPickerDate(baseDate);
  }

  const pickerValue = Platform.OS === "ios" ? iosPickerDate : baseDate;

  const handlePickerChange = (
    event: DateTimePickerEvent,
    selectedDate?: Date,
  ) => {
    if (event.type === "dismissed") {
      setShowPicker(false);
      return;
    }

    if (!selectedDate) return;

    if (Platform.OS === "ios") {
      // On iOS spinner, update local state so picker follows the scroll
      setIosPickerDate(selectedDate);
    } else {
      // On Android, commit immediately and close
      setShowPicker(false);
      onChange(formatTimeFromDate(selectedDate));
    }
  };

  const handleDone = () => {
    onChange(formatTimeFromDate(iosPickerDate));
    setShowPicker(false);
  };

  return (
    <View>
      <Text className="text-[13px] font-medium text-muted mb-1.5 uppercase tracking-wider">
        {label}
      </Text>
      <Pressable
        onPress={() => setShowPicker(true)}
        className="w-full bg-white px-4 py-3.5 rounded-2xl border border-charcoal/10 flex-row items-center justify-between"
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        testID={testID}
      >
        <View className="flex-row items-center">
          <Clock size={16} color={COLORS.muted} style={{ marginRight: 8 }} />
          <Text className="text-[15px] text-charcoal">{value}</Text>
        </View>
        <ChevronDown size={18} color={COLORS.muted} />
      </Pressable>
      {helperText ? (
        <Text className="text-[12px] text-muted mt-1.5">{helperText}</Text>
      ) : null}

      {showPicker ? (
        <View className="mt-2 rounded-2xl border border-charcoal/10 bg-white overflow-hidden">
          {Platform.OS === "ios" ? (
            <Pressable
              onPress={handleDone}
              className="items-center py-3 border-b border-charcoal/10"
              accessibilityRole="button"
              accessibilityLabel="Done selecting time"
            >
              <Text className="text-[15px] font-semibold text-sage">Done</Text>
            </Pressable>
          ) : null}
          <DateTimePicker
            value={pickerValue}
            mode="time"
            display={Platform.OS === "ios" ? "spinner" : "default"}
            minuteInterval={1}
            onChange={handlePickerChange}
          />
        </View>
      ) : null}
    </View>
  );
}
