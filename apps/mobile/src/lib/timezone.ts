import type { Reminder, Senior } from "@/src/types";

export const DEFAULT_TIMEZONE = "America/New_York";

/** Returns the IANA timezone of the device (e.g. "America/Argentina/Buenos_Aires"). */
export function getDeviceTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_TIMEZONE;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

const STATE_NAMES: Record<string, string> = {
  alabama: "AL",
  alaska: "AK",
  arizona: "AZ",
  arkansas: "AR",
  california: "CA",
  colorado: "CO",
  connecticut: "CT",
  delaware: "DE",
  "district of columbia": "DC",
  florida: "FL",
  georgia: "GA",
  hawaii: "HI",
  idaho: "ID",
  illinois: "IL",
  indiana: "IN",
  iowa: "IA",
  kansas: "KS",
  kentucky: "KY",
  louisiana: "LA",
  maine: "ME",
  maryland: "MD",
  massachusetts: "MA",
  michigan: "MI",
  minnesota: "MN",
  mississippi: "MS",
  missouri: "MO",
  montana: "MT",
  nebraska: "NE",
  nevada: "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  ohio: "OH",
  oklahoma: "OK",
  oregon: "OR",
  pennsylvania: "PA",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  tennessee: "TN",
  texas: "TX",
  utah: "UT",
  vermont: "VT",
  virginia: "VA",
  washington: "WA",
  "west virginia": "WV",
  wisconsin: "WI",
  wyoming: "WY",
};

const STATE_TIMEZONES: Record<string, string> = {
  AL: "America/Chicago",
  AK: "America/Anchorage",
  AZ: "America/Phoenix",
  AR: "America/Chicago",
  CA: "America/Los_Angeles",
  CO: "America/Denver",
  CT: "America/New_York",
  DC: "America/New_York",
  DE: "America/New_York",
  FL: "America/New_York",
  GA: "America/New_York",
  HI: "Pacific/Honolulu",
  IA: "America/Chicago",
  ID: "America/Boise",
  IL: "America/Chicago",
  IN: "America/Indiana/Indianapolis",
  KS: "America/Chicago",
  KY: "America/New_York",
  LA: "America/Chicago",
  MA: "America/New_York",
  MD: "America/New_York",
  ME: "America/New_York",
  MI: "America/Detroit",
  MN: "America/Chicago",
  MO: "America/Chicago",
  MS: "America/Chicago",
  MT: "America/Denver",
  NC: "America/New_York",
  ND: "America/Chicago",
  NE: "America/Chicago",
  NH: "America/New_York",
  NJ: "America/New_York",
  NM: "America/Denver",
  NV: "America/Los_Angeles",
  NY: "America/New_York",
  OH: "America/New_York",
  OK: "America/Chicago",
  OR: "America/Los_Angeles",
  PA: "America/New_York",
  RI: "America/New_York",
  SC: "America/New_York",
  SD: "America/Chicago",
  TN: "America/Chicago",
  TX: "America/Chicago",
  UT: "America/Denver",
  VA: "America/New_York",
  VT: "America/New_York",
  WA: "America/Los_Angeles",
  WI: "America/Chicago",
  WV: "America/New_York",
  WY: "America/Denver",
};

const CITY_TIMEZONE_OVERRIDES: Record<string, string> = {
  "az:kayenta": "America/Denver",
  "az:tuba city": "America/Denver",
  "fl:crestview": "America/Chicago",
  "fl:destin": "America/Chicago",
  "fl:fort walton beach": "America/Chicago",
  "fl:milton": "America/Chicago",
  "fl:niceville": "America/Chicago",
  "fl:panama city": "America/Chicago",
  "fl:pensacola": "America/Chicago",
  "id:coeur d alene": "America/Los_Angeles",
  "id:lewiston": "America/Los_Angeles",
  "id:moscow": "America/Los_Angeles",
  "in:evansville": "America/Chicago",
  "in:gary": "America/Chicago",
  "in:hammond": "America/Chicago",
  "in:merrillville": "America/Chicago",
  "in:michigan city": "America/Chicago",
  "in:tell city": "America/Chicago",
  "in:valparaiso": "America/Chicago",
  "ks:colby": "America/Denver",
  "ks:goodland": "America/Denver",
  "ks:tribune": "America/Denver",
  "ky:bowling green": "America/Chicago",
  "ky:henderson": "America/Chicago",
  "ky:hopkinsville": "America/Chicago",
  "ky:owensboro": "America/Chicago",
  "ky:paducah": "America/Chicago",
  "mi:escanaba": "America/Chicago",
  "mi:iron mountain": "America/Chicago",
  "mi:menominee": "America/Chicago",
  "ne:alliance": "America/Denver",
  "ne:chadron": "America/Denver",
  "ne:scottsbluff": "America/Denver",
  "ne:sidney": "America/Denver",
  "nd:dickinson": "America/Denver",
  "nd:williston": "America/Chicago",
  "nv:west wendover": "America/Denver",
  "or:ontario": "America/Boise",
  "sd:deadwood": "America/Denver",
  "sd:rapid city": "America/Denver",
  "sd:spearfish": "America/Denver",
  "sd:sturgis": "America/Denver",
  "tn:bristol": "America/New_York",
  "tn:chattanooga": "America/New_York",
  "tn:cleveland": "America/New_York",
  "tn:johnson city": "America/New_York",
  "tn:kingsport": "America/New_York",
  "tn:knoxville": "America/New_York",
  "tx:el paso": "America/Denver",
};

type TimeParts = {
  hours: number;
  minutes: number;
};

type DateTimeParts = TimeParts & {
  year: number;
  month: number;
  day: number;
};

function normalizeCity(city?: string) {
  return String(city || "")
    .trim()
    .toLowerCase()
    .replace(/[.']/g, "")
    .replace(/\s+/g, " ");
}

function normalizeState(state?: string) {
  const normalized = String(state || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!normalized) return "";
  if (normalized.length === 2) return normalized.toUpperCase();
  return STATE_NAMES[normalized] || "";
}

export function isValidTimezone(timezone?: string) {
  if (!timezone) return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export function resolveTimezoneFromLocation(location?: Pick<Senior, "timezone" | "city" | "state">) {
  if (isValidTimezone(location?.timezone)) return location!.timezone!;

  const state = normalizeState(location?.state);
  const city = normalizeCity(location?.city);

  if (state && city) {
    const cityTimezone = CITY_TIMEZONE_OVERRIDES[`${state.toLowerCase()}:${city}`];
    if (cityTimezone) return cityTimezone;
  }

  if (state && STATE_TIMEZONES[state]) return STATE_TIMEZONES[state];
  // Fallback to the device's timezone instead of hardcoded US Eastern
  return getDeviceTimezone();
}

export function resolveSeniorTimezone(senior?: Pick<Senior, "timezone" | "city" | "state">) {
  return resolveTimezoneFromLocation(senior);
}

export function parseTimeString(timeStr: string): TimeParts | null {
  const matchAmPm = timeStr.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (matchAmPm) {
    let hours = Number.parseInt(matchAmPm[1], 10);
    const minutes = Number.parseInt(matchAmPm[2], 10);
    const period = matchAmPm[3].toUpperCase();
    if (hours < 1 || hours > 12 || minutes < 0 || minutes > 59) return null;
    if (period === "PM" && hours !== 12) hours += 12;
    if (period === "AM" && hours === 12) hours = 0;
    return { hours, minutes };
  }

  const match24 = timeStr.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (match24) {
    const hours = Number.parseInt(match24[1], 10);
    const minutes = Number.parseInt(match24[2], 10);
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
    return { hours, minutes };
  }

  return null;
}

export function formatTime12h(hours: number, minutes: number) {
  const period = hours < 12 ? "AM" : "PM";
  const displayHour = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;
  return `${displayHour}:${minutes.toString().padStart(2, "0")} ${period}`;
}

export function formatTimeFromDate(date: Date) {
  return formatTime12h(date.getHours(), date.getMinutes());
}

export function dateFromTimeString(timeStr: string) {
  const parsed = parseTimeString(timeStr) || { hours: 9, minutes: 0 };
  const date = new Date();
  date.setHours(parsed.hours, parsed.minutes, 0, 0);
  return date;
}

export function cronExpressionFromTime(timeStr: string) {
  const parsed = parseTimeString(timeStr);
  if (!parsed) return undefined;
  return `${parsed.minutes} ${parsed.hours} * * *`;
}

export function parseDailyCronExpression(cronExpression?: string): TimeParts | null {
  if (!cronExpression) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = cronExpression.trim().split(/\s+/);
  if (dayOfMonth !== "*" || month !== "*" || dayOfWeek !== "*") return null;
  if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour)) return null;
  const minutes = Number.parseInt(minute, 10);
  const hours = Number.parseInt(hour, 10);
  if (minutes < 0 || minutes > 59 || hours < 0 || hours > 23) return null;
  return { hours, minutes };
}

export function getDatePartsInTimezone(date: Date, timezone: string): DateTimeParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: isValidTimezone(timezone) ? timezone : DEFAULT_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value]),
  );

  return {
    year: Number.parseInt(parts.year, 10),
    month: Number.parseInt(parts.month, 10),
    day: Number.parseInt(parts.day, 10),
    hours: Number.parseInt(parts.hour, 10) % 24,
    minutes: Number.parseInt(parts.minute, 10),
  };
}

export function zonedWallTimeToUtcDate(parts: DateTimeParts, timezone: string) {
  const targetAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hours,
    parts.minutes,
    0,
    0,
  );
  let utcMs = targetAsUtc;

  for (let i = 0; i < 4; i += 1) {
    const observed = getDatePartsInTimezone(new Date(utcMs), timezone);
    const observedAsUtc = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hours,
      observed.minutes,
      0,
      0,
    );
    const diff = observedAsUtc - targetAsUtc;
    if (diff === 0) break;
    utcMs -= diff;
  }

  return new Date(utcMs);
}

export function timeStringToUtcIso(timeStr: string, timezone: string, now = new Date()) {
  const parsed = parseTimeString(timeStr);
  if (!parsed) return new Date().toISOString();
  const localDate = getDatePartsInTimezone(now, timezone);
  return zonedWallTimeToUtcDate(
    {
      year: localDate.year,
      month: localDate.month,
      day: localDate.day,
      hours: parsed.hours,
      minutes: parsed.minutes,
    },
    timezone,
  ).toISOString();
}

export function formatIsoInTimezone(iso: string, timezone: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "9:00 AM";
  const parts = getDatePartsInTimezone(date, timezone);
  return formatTime12h(parts.hours, parts.minutes);
}

export function getReminderTimeLabel(reminder: Reminder, timezone: string) {
  if (reminder.isRecurring) {
    const cronTime = parseDailyCronExpression(reminder.cronExpression);
    if (cronTime) return formatTime12h(cronTime.hours, cronTime.minutes);
  }

  if (!reminder.scheduledTime) return "Not scheduled";
  return formatIsoInTimezone(reminder.scheduledTime, timezone);
}
