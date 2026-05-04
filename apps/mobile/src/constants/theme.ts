export const COLORS = {
  sage: "#4A5D4F",
  sageDark: "#3d4e42",
  cream: "#FDFCF8",
  beige: "#F2F0E9",
  accentPink: "#E8A0A0",
  accentPinkHover: "#D89090",
  charcoal: "#1A1A1A",
  muted: "#5E5D5A",
  white: "#FFFFFF",
  border: "rgba(26, 26, 26, 0.1)",
  success: "#2E7D32",
  successBg: "#E8F5E9",
  warning: "#E65100",
  warningBg: "#FFF3E0",
  destructive: "#d4183d",
} as const;

export const CALL_TITLE_OPTIONS = [
  "Daily Call",
  "Morning Briefing",
  "Check-In",
  "Catch-Up",
  "Quick Reminders",
] as const;

export const RELATIONSHIP_OPTIONS = [
  "Myself",
  "Daughter",
  "Son",
  "Spouse",
  "Sibling",
  "Grandchild",
  "Uncle",
  "Aunt",
  "Cousin",
  "Friend",
  "Professional Caregiver",
  "Other",
] as const;

export const TIME_OPTIONS = Array.from({ length: 96 }, (_, i) => {
  const hour = Math.floor(i / 4);
  const minute = (i % 4) * 15;
  const period = hour < 12 ? "AM" : "PM";
  const displayHour = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  return `${displayHour}:${minute.toString().padStart(2, "0")} ${period}`;
});
