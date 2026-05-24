export const DEFAULT_TIMEZONE = 'America/New_York';

const STATE_NAMES = {
  alabama: 'AL',
  alaska: 'AK',
  arizona: 'AZ',
  arkansas: 'AR',
  california: 'CA',
  colorado: 'CO',
  connecticut: 'CT',
  delaware: 'DE',
  'district of columbia': 'DC',
  florida: 'FL',
  georgia: 'GA',
  hawaii: 'HI',
  idaho: 'ID',
  illinois: 'IL',
  indiana: 'IN',
  iowa: 'IA',
  kansas: 'KS',
  kentucky: 'KY',
  louisiana: 'LA',
  maine: 'ME',
  maryland: 'MD',
  massachusetts: 'MA',
  michigan: 'MI',
  minnesota: 'MN',
  mississippi: 'MS',
  missouri: 'MO',
  montana: 'MT',
  nebraska: 'NE',
  nevada: 'NV',
  'new hampshire': 'NH',
  'new jersey': 'NJ',
  'new mexico': 'NM',
  'new york': 'NY',
  'north carolina': 'NC',
  'north dakota': 'ND',
  ohio: 'OH',
  oklahoma: 'OK',
  oregon: 'OR',
  pennsylvania: 'PA',
  'rhode island': 'RI',
  'south carolina': 'SC',
  'south dakota': 'SD',
  tennessee: 'TN',
  texas: 'TX',
  utah: 'UT',
  vermont: 'VT',
  virginia: 'VA',
  washington: 'WA',
  'west virginia': 'WV',
  wisconsin: 'WI',
  wyoming: 'WY',
};

const STATE_TIMEZONES = {
  AL: 'America/Chicago',
  AK: 'America/Anchorage',
  AZ: 'America/Phoenix',
  AR: 'America/Chicago',
  CA: 'America/Los_Angeles',
  CO: 'America/Denver',
  CT: 'America/New_York',
  DC: 'America/New_York',
  DE: 'America/New_York',
  FL: 'America/New_York',
  GA: 'America/New_York',
  HI: 'Pacific/Honolulu',
  IA: 'America/Chicago',
  ID: 'America/Boise',
  IL: 'America/Chicago',
  IN: 'America/Indiana/Indianapolis',
  KS: 'America/Chicago',
  KY: 'America/New_York',
  LA: 'America/Chicago',
  MA: 'America/New_York',
  MD: 'America/New_York',
  ME: 'America/New_York',
  MI: 'America/Detroit',
  MN: 'America/Chicago',
  MO: 'America/Chicago',
  MS: 'America/Chicago',
  MT: 'America/Denver',
  NC: 'America/New_York',
  ND: 'America/Chicago',
  NE: 'America/Chicago',
  NH: 'America/New_York',
  NJ: 'America/New_York',
  NM: 'America/Denver',
  NV: 'America/Los_Angeles',
  NY: 'America/New_York',
  OH: 'America/New_York',
  OK: 'America/Chicago',
  OR: 'America/Los_Angeles',
  PA: 'America/New_York',
  RI: 'America/New_York',
  SC: 'America/New_York',
  SD: 'America/Chicago',
  TN: 'America/Chicago',
  TX: 'America/Chicago',
  UT: 'America/Denver',
  VA: 'America/New_York',
  VT: 'America/New_York',
  WA: 'America/Los_Angeles',
  WI: 'America/Chicago',
  WV: 'America/New_York',
  WY: 'America/Denver',
};

const CITY_TIMEZONE_OVERRIDES = {
  'az:kayenta': 'America/Denver',
  'az:tuba city': 'America/Denver',
  'fl:crestview': 'America/Chicago',
  'fl:destin': 'America/Chicago',
  'fl:fort walton beach': 'America/Chicago',
  'fl:milton': 'America/Chicago',
  'fl:niceville': 'America/Chicago',
  'fl:panama city': 'America/Chicago',
  'fl:pensacola': 'America/Chicago',
  'id:coeur d alene': 'America/Los_Angeles',
  'id:lewiston': 'America/Los_Angeles',
  'id:moscow': 'America/Los_Angeles',
  'in:evansville': 'America/Chicago',
  'in:gary': 'America/Chicago',
  'in:hammond': 'America/Chicago',
  'in:merrillville': 'America/Chicago',
  'in:michigan city': 'America/Chicago',
  'in:tell city': 'America/Chicago',
  'in:valparaiso': 'America/Chicago',
  'ks:colby': 'America/Denver',
  'ks:goodland': 'America/Denver',
  'ks:tribune': 'America/Denver',
  'ky:bowling green': 'America/Chicago',
  'ky:henderson': 'America/Chicago',
  'ky:hopkinsville': 'America/Chicago',
  'ky:owensboro': 'America/Chicago',
  'ky:paducah': 'America/Chicago',
  'mi:escanaba': 'America/Chicago',
  'mi:iron mountain': 'America/Chicago',
  'mi:menominee': 'America/Chicago',
  'ne:alliance': 'America/Denver',
  'ne:chadron': 'America/Denver',
  'ne:scottsbluff': 'America/Denver',
  'ne:sidney': 'America/Denver',
  'nd:dickinson': 'America/Denver',
  'nd:williston': 'America/Chicago',
  'nv:west wendover': 'America/Denver',
  'or:ontario': 'America/Boise',
  'sd:deadwood': 'America/Denver',
  'sd:rapid city': 'America/Denver',
  'sd:spearfish': 'America/Denver',
  'sd:sturgis': 'America/Denver',
  'tn:bristol': 'America/New_York',
  'tn:chattanooga': 'America/New_York',
  'tn:cleveland': 'America/New_York',
  'tn:johnson city': 'America/New_York',
  'tn:kingsport': 'America/New_York',
  'tn:knoxville': 'America/New_York',
  'tx:el paso': 'America/Denver',
};

function normalizeCity(city) {
  return String(city || '')
    .trim()
    .toLowerCase()
    .replace(/[.']/g, '')
    .replace(/\s+/g, ' ');
}

function normalizeState(state) {
  const normalized = String(state || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!normalized) return '';
  if (normalized.length === 2) return normalized.toUpperCase();
  return STATE_NAMES[normalized] || '';
}

export function isValidTimezone(timezone) {
  if (!timezone) return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export function resolveTimezoneFromProfile(profile = {}) {
  if (isValidTimezone(profile.timezone)) return profile.timezone;

  const state = normalizeState(profile.state);
  const city = normalizeCity(profile.city);

  if (state && city) {
    const cityTimezone = CITY_TIMEZONE_OVERRIDES[`${state.toLowerCase()}:${city}`];
    if (cityTimezone) return cityTimezone;
  }

  if (state && STATE_TIMEZONES[state]) return STATE_TIMEZONES[state];
  return DEFAULT_TIMEZONE;
}

export function parseTimeString(timeStr) {
  if (!timeStr) return null;

  const matchAmPm = String(timeStr).trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (matchAmPm) {
    let hours = Number.parseInt(matchAmPm[1], 10);
    const minutes = Number.parseInt(matchAmPm[2], 10);
    const period = matchAmPm[3].toUpperCase();
    if (hours < 1 || hours > 12 || minutes < 0 || minutes > 59) return null;
    if (period === 'PM' && hours !== 12) hours += 12;
    if (period === 'AM' && hours === 12) hours = 0;
    return { hours, minutes };
  }

  const match24 = String(timeStr).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (match24) {
    const hours = Number.parseInt(match24[1], 10);
    const minutes = Number.parseInt(match24[2], 10);
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
    return { hours, minutes };
  }

  return null;
}

export function formatTime12h(hours, minutes) {
  const period = hours < 12 ? 'AM' : 'PM';
  const displayHour = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;
  return `${displayHour}:${String(minutes).padStart(2, '0')} ${period}`;
}

export function cronExpressionFromTime(timeStr) {
  const parsed = parseTimeString(timeStr);
  if (!parsed) return null;
  return `${parsed.minutes} ${parsed.hours} * * *`;
}

export function parseDailyCronExpression(cronExpression) {
  if (!cronExpression) return null;
  const parts = String(cronExpression).trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  if (dayOfMonth !== '*' || month !== '*' || dayOfWeek !== '*') return null;
  if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour)) return null;
  const minutes = Number.parseInt(minute, 10);
  const hours = Number.parseInt(hour, 10);
  if (minutes < 0 || minutes > 59 || hours < 0 || hours > 23) return null;
  return { hours, minutes };
}

function partsFromFormatter(date, timezone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: isValidTimezone(timezone) ? timezone : DEFAULT_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });

  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value])
  );

  return {
    year: Number.parseInt(parts.year, 10),
    month: Number.parseInt(parts.month, 10),
    day: Number.parseInt(parts.day, 10),
    hours: Number.parseInt(parts.hour, 10) % 24,
    minutes: Number.parseInt(parts.minute, 10),
  };
}

export function getDatePartsInTimezone(date, timezone) {
  return partsFromFormatter(date, timezone);
}

function wallTimePartsMatch(left, right) {
  return left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hours === right.hours &&
    left.minutes === right.minutes;
}

export function zonedWallTimeToUtcDate({ year, month, day, hours, minutes }, timezone) {
  const targetAsUtc = Date.UTC(year, month - 1, day, hours, minutes, 0, 0);
  let utcMs = targetAsUtc;
  const targetParts = { year, month, day, hours, minutes };

  for (let i = 0; i < 4; i += 1) {
    const observed = getDatePartsInTimezone(new Date(utcMs), timezone);
    const observedAsUtc = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hours,
      observed.minutes,
      0,
      0
    );
    const diff = observedAsUtc - targetAsUtc;
    if (diff === 0) break;
    utcMs -= diff;
  }

  const observed = getDatePartsInTimezone(new Date(utcMs), timezone);
  if (!wallTimePartsMatch(observed, targetParts)) {
    const observedAsUtc = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hours,
      observed.minutes,
      0,
      0
    );
    const gapMs = targetAsUtc - observedAsUtc;
    if (gapMs > 0 && gapMs <= 3 * 60 * 60 * 1000) {
      utcMs += gapMs;
    }
  }

  return new Date(utcMs);
}

export function wallTimeTodayToUtcDate(timeStr, timezone, now = new Date()) {
  const parsed = parseTimeString(timeStr);
  if (!parsed) return null;
  const localDate = getDatePartsInTimezone(now, timezone);
  return zonedWallTimeToUtcDate(
    {
      year: localDate.year,
      month: localDate.month,
      day: localDate.day,
      hours: parsed.hours,
      minutes: parsed.minutes,
    },
    timezone
  );
}

export function formatIsoInTimezone(isoString, timezone) {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return null;
  const parts = getDatePartsInTimezone(date, timezone);
  return formatTime12h(parts.hours, parts.minutes);
}
