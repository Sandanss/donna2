import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { secureDraftStorage } from "@/src/lib/secureDraftStorage";

export type OnboardingAuthProvider = "email" | "google" | "apple" | null;

export interface OnboardingCall {
  title: string;
  frequency: "daily" | "recurring" | "one-time";
  selectedDays: number[];
  selectedDate: string;
  callTime: string;
  selectedReminderIds: number[];
}

interface OnboardingState {
  // How the caregiver entered setup. Apple skips duplicate identity prompts.
  authProvider: OnboardingAuthProvider;
  // Donna language (for calls with senior)
  donnaLanguage: "en" | "es";
  // Caregiver
  firstName: string;
  lastName: string;
  phone: string;
  caregiverCity: string;
  caregiverState: string;
  caregiverZipcode: string;
  // Loved one
  lovedOneName: string;
  lovedOnePhone: string;
  relationship: string;
  city: string;
  state: string;
  zipcode: string;
  // Interests
  selectedInterests: Record<string, string>;
  additionalTopics: string;
  topicsToAvoid: string;
  // Reminders
  reminders: { title: string; description: string }[];
  // Schedule
  calls: OnboardingCall[];
  // Actions
  setField: <K extends keyof OnboardingState>(
    field: K,
    value: OnboardingState[K],
  ) => void;
  addReminder: () => void;
  removeReminder: (index: number) => void;
  updateReminder: (
    index: number,
    field: "title" | "description",
    value: string,
  ) => void;
  addCall: () => void;
  removeCall: (index: number) => void;
  updateCall: <K extends keyof OnboardingCall>(
    index: number,
    field: K,
    value: OnboardingCall[K],
  ) => void;
  toggleInterest: (id: string) => void;
  updateInterestDetail: (id: string, value: string) => void;
  removeInterest: (id: string) => void;
  reset: () => void;
}

const DEFAULT_CALL: OnboardingCall = {
  title: "Daily Call",
  frequency: "daily",
  selectedDays: [],
  selectedDate: new Date().toISOString(),
  callTime: "9:00 AM",
  selectedReminderIds: [],
};

const ONBOARDING_DRAFT_KEY = "donna-onboarding-draft-v1";

const INITIAL_STATE = {
  authProvider: null as OnboardingAuthProvider,
  donnaLanguage: "en" as "en" | "es",
  firstName: "",
  lastName: "",
  phone: "",
  caregiverCity: "",
  caregiverState: "",
  caregiverZipcode: "",
  lovedOneName: "",
  lovedOnePhone: "",
  relationship: "",
  city: "",
  state: "",
  zipcode: "",
  selectedInterests: {} as Record<string, string>,
  additionalTopics: "",
  topicsToAvoid: "",
  reminders: [{ title: "", description: "" }],
  calls: [{ ...DEFAULT_CALL }],
};

// Address fields (city/state/zipcode for both caregiver and loved one) are
// intentionally excluded from the persisted draft. Stale addresses from a
// prior onboarding session would otherwise rehydrate as fake "defaults",
// letting a fresh user advance past validation without consciously entering
// their own location.
const draftFields = (state: OnboardingState) => ({
  authProvider: state.authProvider,
  donnaLanguage: state.donnaLanguage,
  firstName: state.firstName,
  lastName: state.lastName,
  phone: state.phone,
  lovedOneName: state.lovedOneName,
  lovedOnePhone: state.lovedOnePhone,
  relationship: state.relationship,
  selectedInterests: state.selectedInterests,
  additionalTopics: state.additionalTopics,
  topicsToAvoid: state.topicsToAvoid,
  reminders: state.reminders,
  calls: state.calls,
});

export const useOnboardingStore = create<OnboardingState>()(
  persist(
    (set) => ({
      ...INITIAL_STATE,

      setField: (field, value) => set({ [field]: value }),

      addReminder: () =>
        set((s) => ({
          reminders: [...s.reminders, { title: "", description: "" }],
        })),

      removeReminder: (index) =>
        set((s) => ({
          reminders: s.reminders.filter((_, i) => i !== index),
        })),

      updateReminder: (index, field, value) =>
        set((s) => ({
          reminders: s.reminders.map((r, i) =>
            i === index ? { ...r, [field]: value } : r,
          ),
        })),

      addCall: () =>
        set((s) => ({
          calls: [...s.calls, { ...DEFAULT_CALL }],
        })),

      removeCall: (index) =>
        set((s) => ({
          calls: s.calls.filter((_, i) => i !== index),
        })),

      updateCall: (index, field, value) =>
        set((s) => ({
          calls: s.calls.map((c, i) =>
            i === index ? { ...c, [field]: value } : c,
          ),
        })),

      toggleInterest: (id) =>
        set((s) => {
          const next = { ...s.selectedInterests };
          if (id in next) {
            delete next[id];
          } else {
            next[id] = "";
          }
          return { selectedInterests: next };
        }),

      updateInterestDetail: (id, value) =>
        set((s) => ({
          selectedInterests: { ...s.selectedInterests, [id]: value },
        })),

      removeInterest: (id) =>
        set((s) => {
          const next = { ...s.selectedInterests };
          delete next[id];
          return { selectedInterests: next };
        }),

      reset: () => set({ ...INITIAL_STATE }),
    }),
    {
      name: ONBOARDING_DRAFT_KEY,
      storage: createJSONStorage(() => secureDraftStorage),
      partialize: draftFields,
    },
  ),
);

export async function clearOnboardingDraft() {
  useOnboardingStore.setState({ ...INITIAL_STATE });
  await secureDraftStorage.removeItem(ONBOARDING_DRAFT_KEY);
}
