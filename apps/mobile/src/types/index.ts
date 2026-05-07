export interface Senior {
  id: string;
  name: string;
  phone: string;
  timezone?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  interests?: string[];
  additionalInfo?: string;
  familyInfo?: Record<string, unknown>;
  preferredCallTimes?: Record<string, unknown>;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  /** Present when returned via /api/caregivers/me (from caregiver assignment) */
  role?: string;
}

export interface Reminder {
  id: string;
  seniorId: string;
  type: "medication" | "appointment" | "custom" | "wellness" | "social";
  title: string;
  description?: string;
  scheduledTime?: string;
  isRecurring: boolean;
  cronExpression?: string;
  isActive: boolean;
  lastDeliveredAt?: string;
  createdAt: string;
  createdVia?: "manual" | "voice";
}

export interface Conversation {
  id: string;
  seniorId: string;
  callSid: string;
  startedAt: string;
  endedAt?: string;
  durationSeconds?: number;
  status: string;
  summary?: string;
  sentiment?: string;
  concerns?: string[];
  analysis?: CallAnalysis | null;
}

export interface CallAnalysis {
  id: string;
  conversationId: string;
  seniorId: string;
  summary?: string;
  sentiment?: string;
  mood?: string;
  topics?: string[];
  engagementScore?: number;
  concerns?: Array<string | Record<string, unknown>>;
  positiveObservations?: string[];
  followUpSuggestions?: string[];
  caregiverSms?: string | null;
  caregiverTakeaways?: string[];
  recommendedCaregiverAction?: string | null;
  callQuality?: Record<string, unknown> | string | null;
}

/**
 * Matches the notification_preferences table in the backend.
 * Fields correspond to: callCompleted, concernDetected, reminderMissed,
 * weeklySummary, smsEnabled (legacy inactive), emailEnabled, quietHours*, timezone,
 * weeklyReport*.
 */
export interface NotificationPreferences {
  caregiverId?: string;
  callCompleted?: boolean;
  concernDetected?: boolean;
  reminderMissed?: boolean;
  weeklySummary?: boolean;
  smsEnabled?: boolean; // Legacy compatibility only; SMS notifications are inactive.
  emailEnabled?: boolean;
  quietHoursStart?: string | null;
  quietHoursEnd?: string | null;
  timezone?: string;
  weeklyReportDay?: number;
  weeklyReportTime?: string;
}

/**
 * Payload for POST /api/onboarding.
 * Must match the onboardingSchema in validators/schemas.js on the backend.
 */
export interface OnboardingInput {
  caregiverPhone?: string;
  senior: {
    name: string;
    phone: string;
    timezone?: string;
    city?: string;
    state?: string;
    zipCode?: string;
  };
  relation: string;
  interests?: string[];
  familyInfo?: {
    relation?: string;
    donnaLanguage?: "en" | "es";
    interestDetails?: Record<string, string>;
    topicsToAvoid?: string;
  };
  additionalInfo?: string;
  reminders?: string[];
  topicsToAvoid?: string[];
  callSchedule?: {
    frequency?: "daily" | "recurring" | "one-time";
    days?: ("Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun")[];
    time?: string;
    date?: string;
  };
}

export interface CaregiverProfile {
  clerkUserId: string;
  seniors: Senior[];
}
