/**
 * Greeting Rotation Service
 *
 * Generates varied, time-aware greetings for seniors so Donna
 * doesn't sound repetitive across calls.
 *
 * Features:
 * - Time-of-day awareness (morning/afternoon/evening) based on senior's timezone
 * - Personalization with senior's name
 * - Optional last-call context weaving
 * - Interest-based greetings with weighted selection
 * - Per-senior rotation tracking (no consecutive repeats)
 */

// Track last used greeting index per senior (resets on process restart)
const lastUsedIndex = new Map();

// ── Morning templates (5 AM – 11:59 AM) ────────────────────────────

const MORNING_TEMPLATES = [
  "Good morning, {name}! It's Donna. How did you sleep last night?",
  "Hey {name}, it's Donna! Hope you had a good night's rest. How are you feeling this morning?",
  "Morning, {name}! Donna here. What are you up to this fine morning?",
  "Good morning, {name}! It's Donna calling. Have you had your breakfast yet?",
  "Hey {name}! Donna here, bright and early. How's your morning going so far?",
  "Hi {name}, good morning! It's Donna. I hope today is off to a great start for you.",
  "{name}, good morning! It's Donna. Anything exciting planned for today?",
  "Morning, {name}! It's your friend Donna. How are you doing today?",
];

// ── Afternoon templates (12 PM – 4:59 PM) ──────────────────────────

const AFTERNOON_TEMPLATES = [
  "Hi {name}, it's Donna! How's your afternoon going?",
  "Hey {name}! Donna here. Having a good day so far?",
  "Good afternoon, {name}! It's Donna calling. What have you been up to today?",
  "{name}, hi! It's Donna. How's the rest of your day been?",
  "Hey there {name}! Donna checking in this afternoon. How are you?",
  "Hi {name}! It's Donna. I hope your day has been a good one so far.",
  "Good afternoon, {name}! Donna here. Tell me, how's your day going?",
  "{name}! It's Donna. Enjoying your afternoon?",
];

// ── Evening templates (5 PM – 4:59 AM) ─────────────────────────────

const EVENING_TEMPLATES = [
  "Good evening, {name}! It's Donna. I hope you had a lovely day.",
  "Hi {name}, it's Donna! How was your day today?",
  "Hey {name}! Donna calling this evening. How are you doing?",
  "{name}, good evening! It's Donna. Have you had a nice day?",
  "Evening, {name}! It's Donna here. How's everything going tonight?",
  "Hi {name}! It's Donna. Winding down for the evening? How was your day?",
  "Hey there {name}! Donna here. Tell me about your day.",
  "Good evening, {name}! Donna checking in. How are you feeling tonight?",
];

// ── Interest-based templates (appended as second sentence) ──────────

const INTEREST_FOLLOWUPS = [
  "Have you had a chance to enjoy any {interest} lately?",
  "Been doing any {interest} this week?",
  "I was thinking about your {interest} - how's that going?",
  "Any updates on the {interest} front?",
  "Done anything fun with {interest} recently?",
  "How's the {interest} going these days?",
];

// ── Last-call context templates (replaces generic followup) ─────────

const CONTEXT_FOLLOWUPS = [
  "Last time we chatted about {context} - any updates?",
  "I remember you mentioned {context}. How did that go?",
  "You were telling me about {context} last time. What happened with that?",
  "I've been curious about {context} since our last chat.",
  "How did things turn out with {context}?",
  "Any news about {context} since we last spoke?",
];

/**
 * Get the local hour for a given timezone
 */
function getLocalHour(timezone) {
  try {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || 'America/New_York',
      hour: 'numeric',
      hour12: false,
    });
    return parseInt(formatter.format(now), 10);
  } catch {
    const fallbackFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      hour12: false,
    });
    return parseInt(fallbackFormatter.format(new Date()), 10);
  }
}

/**
 * Determine time period from hour
 */
function getTimePeriod(hour) {
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  return 'evening';
}

/**
 * Pick a random index from an array, excluding a specific index
 */
function pickIndex(arrayLength, excludeIndex) {
  const indices = Array.from({ length: arrayLength }, (_, i) => i)
    .filter(i => i !== excludeIndex);
  return indices[Math.floor(Math.random() * indices.length)];
}

/**
 * Select an interest using weighted random (boosted by recent memory mentions)
 */
function selectInterest(interests, recentMemories) {
  if (!interests || interests.length === 0) return null;

  const weights = new Map();
  const now = Date.now();
  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
  const FOURTEEN_DAYS = 14 * 24 * 60 * 60 * 1000;

  for (const interest of interests) {
    weights.set(interest.toLowerCase(), 1.0);
  }

  for (const memory of recentMemories || []) {
    const content = memory.content?.toLowerCase() || '';
    const memoryAge = now - new Date(memory.createdAt).getTime();

    for (const interest of interests) {
      const key = interest.toLowerCase();
      if (content.includes(key)) {
        const current = weights.get(key) || 1.0;
        if (memoryAge <= SEVEN_DAYS) {
          weights.set(key, current + 2.0);
        } else if (memoryAge <= FOURTEEN_DAYS) {
          weights.set(key, current + 1.0);
        }
      }
    }
  }

  const totalWeight = Array.from(weights.values()).reduce((a, b) => a + b, 0);
  let random = Math.random() * totalWeight;

  for (const interest of interests) {
    const weight = weights.get(interest.toLowerCase()) || 1.0;
    random -= weight;
    if (random <= 0) return interest;
  }

  return interests[0];
}

/**
 * Generate a greeting for a senior
 *
 * @param {object} options
 * @param {string} options.seniorName - Senior's full name (first name extracted)
 * @param {string} [options.timezone] - IANA timezone (default: America/New_York)
 * @param {string[]} [options.interests] - Senior's interests array
 * @param {string} [options.lastCallSummary] - Summary from most recent call
 * @param {object[]} [options.recentMemories] - Recent memories for interest weighting
 * @param {string} [options.seniorId] - Used for per-senior rotation tracking
 * @returns {{ greeting: string, period: string, templateIndex: number, selectedInterest: string|null }}
 */
function getGreeting({ seniorName, timezone, interests, lastCallSummary, recentMemories, seniorId }) {
  const firstName = seniorName?.split(' ')[0] || 'there';
  const localHour = getLocalHour(timezone);
  const period = getTimePeriod(localHour);

  // Select template pool by time period
  const templates = period === 'morning'
    ? MORNING_TEMPLATES
    : period === 'afternoon'
      ? AFTERNOON_TEMPLATES
      : EVENING_TEMPLATES;

  // Get last used index for this senior
  const cacheKey = seniorId || firstName;
  const lastIndex = lastUsedIndex.get(cacheKey) ?? -1;

  // Pick a template that differs from last time
  const templateIndex = pickIndex(templates.length, lastIndex);
  lastUsedIndex.set(cacheKey, templateIndex);

  // Build the base greeting
  let greeting = templates[templateIndex].replace('{name}', firstName);

  // Decide whether to append a followup (interest or context-based)
  // Only add followup ~60% of the time to keep greetings varied in length
  const addFollowup = Math.random() < 0.6;

  if (addFollowup && lastCallSummary) {
    // Extract a short context phrase from the summary (first clause, max 60 chars)
    const contextPhrase = extractContextPhrase(lastCallSummary);
    if (contextPhrase) {
      const ctxIndex = Math.floor(Math.random() * CONTEXT_FOLLOWUPS.length);
      const followup = CONTEXT_FOLLOWUPS[ctxIndex].replace('{context}', contextPhrase);
      greeting += ' ' + followup;
      return { greeting, period, templateIndex, selectedInterest: null };
    }
  }

  if (addFollowup && interests?.length > 0) {
    const selectedInterest = selectInterest(interests, recentMemories);
    if (selectedInterest) {
      const intIndex = Math.floor(Math.random() * INTEREST_FOLLOWUPS.length);
      const followup = INTEREST_FOLLOWUPS[intIndex].replace('{interest}', selectedInterest);
      greeting += ' ' + followup;
      return { greeting, period, templateIndex, selectedInterest };
    }
  }

  return { greeting, period, templateIndex, selectedInterest: null };
}

/**
 * Extract a short, conversational context phrase from a call summary
 * e.g. "Discussed grandson Tommy's soccer game and weekend plans"
 *   -> "Tommy's soccer game"
 */
function extractContextPhrase(summary) {
  if (!summary || summary.length < 10) return null;

  // Take the first sentence/clause, trim to a reasonable length
  const firstClause = summary.split(/[.;!?]/)[0].trim();

  // Remove common summary prefixes
  const cleaned = firstClause
    .replace(/^(discussed|talked about|chatted about|mentioned|shared about|spoke about)\s+/i, '')
    .trim();

  if (cleaned.length < 5) return null;
  if (cleaned.length > 60) return cleaned.substring(0, 57) + '...';

  return cleaned;
}

export const greetingService = {
  getGreeting,
  getLocalHour,
  getTimePeriod,
  selectInterest,
  extractContextPhrase,
  // Expose for testing / context-cache compatibility
  MORNING_TEMPLATES,
  AFTERNOON_TEMPLATES,
  EVENING_TEMPLATES,
  INTEREST_FOLLOWUPS,
  CONTEXT_FOLLOWUPS,
};

export default greetingService;
