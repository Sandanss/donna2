import { forwardRef, useImperativeHandle, useRef } from "react";
import { TextInput, View, Text, TextInputProps } from "react-native";

type InputProps = TextInputProps & {
  label?: string;
  error?: string;
};

export const Input = forwardRef<TextInput, InputProps>(
  ({ label, error, className = "", ...props }, ref) => {
    const inputRef = useRef<TextInput>(null);

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
        />
        {error && <Text className="text-red-500 text-[13px] mt-1">{error}</Text>}
      </View>
    );
  }
);
