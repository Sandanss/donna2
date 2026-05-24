import { forwardRef, useId, useImperativeHandle, useRef } from "react";
import {
  InputAccessoryView,
  Keyboard,
  Platform,
  Pressable,
  TextInput,
  View,
  Text,
  TextInputProps,
} from "react-native";

type InputProps = TextInputProps & {
  label?: string;
  error?: string;
};

export const Input = forwardRef<TextInput, InputProps>(
  ({ label, error, className = "", ...props }, ref) => {
    const inputRef = useRef<TextInput>(null);
    const generatedId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
    const shouldShowDoneAccessory =
      Platform.OS === "ios" &&
      !props.inputAccessoryViewID &&
      (props.keyboardType === "number-pad" || props.keyboardType === "phone-pad");
    const inputAccessoryViewID = shouldShowDoneAccessory
      ? `input-accessory-${generatedId}`
      : props.inputAccessoryViewID;

    useImperativeHandle(ref, () => inputRef.current as TextInput);

    return (
      <View className="w-full">
        {label && (
          <Text
            className="text-[13px] font-medium text-muted mb-1.5 uppercase tracking-wider"
            accessible={false}
          >
            {label}
          </Text>
        )}
        <TextInput
          ref={inputRef}
          className={`w-full bg-white px-4 py-3.5 rounded-2xl border border-charcoal/10 text-[15px] text-charcoal ${
            error ? "border-red-500" : ""
          } ${className}`}
          placeholderTextColor="#5E5D5A"
          accessibilityLabel={label}
          {...props}
          inputAccessoryViewID={inputAccessoryViewID}
        />
        {shouldShowDoneAccessory && (
          <InputAccessoryView nativeID={inputAccessoryViewID}>
            <View className="bg-cream border-t border-charcoal/10 px-4 py-2 items-end">
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Done"
                onPress={Keyboard.dismiss}
                className="min-h-[44px] px-4 justify-center"
              >
                <Text className="text-[16px] font-medium text-sage">Done</Text>
              </Pressable>
            </View>
          </InputAccessoryView>
        )}
        {error && <Text className="text-red-500 text-[13px] mt-1">{error}</Text>}
      </View>
    );
  }
);
