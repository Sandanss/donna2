/**
 * Context Cache Service
 *
 * Pre-caches senior context early in their timezone day so it's ready
 * for calls (whether inbound or outbound).
 *
 * Cached data:
 * - Recent call summaries
 * - Critical memories (Tier 1)
 * - Important memories (with decay applied)
 * - Pre-generated greeting (templated with rotation)
 * - Interest-based news, persisted to seniors.cached_news for Pipecat calls
 */

import { memoryService } from './memory.js';
import { conversationService } from './conversations.js';
import { seniorService } from './seniors.js';
import { greetingService } from './greetings.js';
import { newsService } from './news.js';
import { db } from '../db/client.js';
import { seniors as seniorsTable } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { createLogger } from '../lib/logger.js';

const log = createLogger('ContextCache');

// In-memory cache (could be Redis for multi-instance deployments)
const cache = new Map();

// Cache TTL: 24 hours
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// Pre-fetch hour in local timezone (5 AM)
const PREFETCH_HOUR = 5;

// Greeting templates - {name} and {interest} are replaced dynamically
const GREETING_TEMPLATES = [
  // Warm & curious
  "Hey {name}! It's Donna. I was just thinking about your {interest} - how's that going?",
  // Casual check-in
  "Hi {name}, Donna here! Have you had a chance to enjoy any {interest} lately?",
  // Enthusiastic
  "{name}! So good to talk to you. Tell me - anything new with your {interest}?",
  // Gentle opener
  "Hello {name}, it's Donna calling. I'd love to hear what you've been up to with {interest}.",
  // Direct & friendly
  "Hey there {name}! Donna checking in. Been doing any {interest} this week?",
  // Conversational
  "{name}, hi! It's Donna. I was curious - how's the {interest} going these days?"
];

// Fallback templates when no interests defined
const FALLBACK_TEMPLATES = [
  "Hey {name}! It's Donna. How have you been?",
  "Hi {name}, Donna here! How are you doing today?",
  "{name}! So good to talk to you. What's new?",
  "Hello {name}, it's Donna calling. How's everything going?",
  "Hey there {name}! Donna checking in. How are you?",
  "{name}, hi! It's Donna. How's your day been?"
];

/**
 * Get local hour for a timezone
 */
function getLocalHour(timezone) {
  try {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || 'America/New_York',
      hour: 'numeric',
      hour12: false
    });
    return parseInt(formatter.format(now), 10);
  } catch (e) {
    // Default to New York local time if the profile timezone is invalid.
    const fallbackFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      hour12: false
    });
    return parseInt(fallbackFormatter.format(new Date()), 10);
  }
}

/**
 * Select an interest using weighted random selection
 * Weights are boosted by recency of mention in memories
 */
function selectInterest(interests, recentMemories) {
  if (!interests || interests.length === 0) {
    return null;
  }

  // Calculate weights based on memory recency
  const weights = new Map();
  const now = Date.now();
  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
  const FOURTEEN_DAYS = 14 * 24 * 60 * 60 * 1000;

  // Base weight for all interests
  for (const interest of interests) {
    weights.set(interest.toLowerCase(), 1.0);
  }

  // Boost weights based on recent memory mentions
  for (const memory of recentMemories || []) {
    const content = memory.content?.toLowerCase() || '';
    const memoryAge = now - new Date(memory.createdAt).getTime();

    for (const interest of interests) {
      const interestLower = interest.toLowerCase();
      if (content.includes(interestLower)) {
        const currentWeight = weights.get(interestLower) || 1.0;
        if (memoryAge <= SEVEN_DAYS) {
          weights.set(interestLower, currentWeight + 2.0);
        } else if (memoryAge <= FOURTEEN_DAYS) {
          weights.set(interestLower, currentWeight + 1.0);
        }
      }
    }
  }

  // Weighted random selection
  const totalWeight = Array.from(weights.values()).reduce((a, b) => a + b, 0);
  let random = Math.random() * totalWeight;

  for (const interest of interests) {
    const weight = weights.get(interest.toLowerCase()) || 1.0;
    random -= weight;
    if (random <= 0) {
      return interest;
    }
  }

  // Fallback to first interest
  return interests[0];
}

/**
 * Generate a templated greeting with rotation
 * Returns { greeting, templateIndex }
 */
function generateTemplatedGreeting(senior, recentMemories, lastGreetingIndex) {
  const firstName = senior?.name?.split(' ')[0] || 'there';
  const interests = senior?.interests || [];

  // Select interest with weighted random
  const selectedInterest = selectInterest(interests, recentMemories);

  // Choose template array based on whether we have interests
  const templates = selectedInterest ? GREETING_TEMPLATES : FALLBACK_TEMPLATES;

  // Select template index (exclude last used)
  let availableIndices = templates.map((_, i) => i);
  if (lastGreetingIndex >= 0 && lastGreetingIndex < templates.length) {
    availableIndices = availableIndices.filter(i => i !== lastGreetingIndex);
  }
  const templateIndex = availableIndices[Math.floor(Math.random() * availableIndices.length)];

  // Fill template
  let greeting = templates[templateIndex]
    .replace('{name}', firstName);

  if (selectedInterest) {
    greeting = greeting.replace('{interest}', selectedInterest);
  }

  return { greeting, templateIndex, selectedInterest };
}

/**
 * Generate simple fallback greeting (legacy, kept for compatibility)
 */
function generateGreeting(senior, localHour) {
  const firstName = senior?.name?.split(' ')[0] || 'there';

  let timeGreeting;
  if (localHour >= 5 && localHour < 12) {
    timeGreeting = 'Good morning';
  } else if (localHour >= 12 && localHour < 17) {
    timeGreeting = 'Good afternoon';
  } else {
    timeGreeting = 'Good evening';
  }

  return `${timeGreeting}, ${firstName}! It's Donna. How are you doing today?`;
}

/**
 * Pre-fetch and cache context for a senior
 */
async function prefetchAndCache(seniorId) {
  const startTime = Date.now();

  try {
    // Get senior profile
    const senior = await seniorService.getById(seniorId);
    if (!senior) {
      log.info('Senior not found, skipping', { seniorId });
      return null;
    }

    const newsPromise = senior.interests?.length
      ? newsService.getNewsForSenior(senior.interests, 8).catch((error) => {
          log.warn('News prefetch failed', { seniorId, error: error.message });
          return null;
        })
      : Promise.resolve(null);

    // Fetch all context in parallel (including recent memories for greeting interest weighting)
    const [
      summaries,
      criticalMemories,
      importantMemories,
      recentMemories,
      newsContextFull,
    ] = await Promise.all([
      conversationService.getRecentSummaries(seniorId, 3),
      memoryService.getCritical(seniorId, 3),
      memoryService.getImportant(seniorId, 5),
      memoryService.getRecent(seniorId, 10),
      newsPromise
    ]);

    if (newsContextFull) {
      await db.update(seniorsTable)
        .set({
          cachedNews: newsContextFull,
          cachedNewsUpdatedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(seniorsTable.id, seniorId));
      log.info('Persisted cached news', { seniorId });
    } else if (senior.interests?.length) {
      log.warn('No fresh news cached', { seniorId, interestsCount: senior.interests.length });
    }

    // Get last call summary for context-aware greetings
    const lastCallSummary = summaries || null;

    // Generate greeting using the greeting rotation service
    const { greeting, period, templateIndex, selectedInterest } = greetingService.getGreeting({
      seniorName: senior.name,
      timezone: senior.timezone,
      interests: senior.interests,
      lastCallSummary,
      recentMemories,
      seniorId: senior.id,
    });

    log.info('Generated greeting', {
      seniorId,
      period,
      templateIndex,
      selectedInterestPresent: Boolean(selectedInterest),
    });

    // Build memory context string (Tier 1 + important)
    const memoryParts = [];
    if (criticalMemories.length > 0) {
      memoryParts.push('Critical to know:');
      criticalMemories.forEach(m => memoryParts.push(`- ${m.content}`));
    }
    if (importantMemories.length > 0) {
      // Filter out duplicates from critical
      const criticalIds = new Set(criticalMemories.map(m => m.id));
      const unique = importantMemories.filter(m => !criticalIds.has(m.id));
      if (unique.length > 0) {
        const groups = memoryService.groupByType(unique);
        const formatted = memoryService.formatGroupedMemories(groups);
        memoryParts.push('\nBackground:\n' + formatted);
      }
    }

    const cachedContext = {
      seniorId,
      senior,
      summaries,
      criticalMemories,
      importantMemories,
      memoryContext: memoryParts.join('\n'),
      greeting,
      newsContext: newsContextFull,
      newsContextFull,
      newsCachedAt: newsContextFull ? Date.now() : null,
      lastGreetingIndex: templateIndex,
      cachedAt: Date.now(),
      expiresAt: Date.now() + CACHE_TTL_MS
    };

    cache.set(seniorId, cachedContext);

    const elapsed = Date.now() - startTime;
    log.info('Pre-cached context', { seniorId, durationMs: elapsed });

    return cachedContext;
  } catch (error) {
    log.error('Error pre-caching context', { seniorId, error: error.message });
    return null;
  }
}

/**
 * Get cached context for a senior
 * Returns null if not cached or expired
 */
function getCache(seniorId) {
  const cached = cache.get(seniorId);

  if (!cached) {
    return null;
  }

  // Check expiration
  if (Date.now() > cached.expiresAt) {
    cache.delete(seniorId);
    log.info('Cache expired', { seniorId });
    return null;
  }

  log.info('Cache hit', {
    seniorId,
    ageMinutes: Math.round((Date.now() - cached.cachedAt) / 60000),
  });
  return cached;
}

/**
 * Clear cache for a senior (e.g., after a call ends and new memories are stored)
 */
function clearCache(seniorId) {
  if (cache.has(seniorId)) {
    cache.delete(seniorId);
    log.info('Cleared cache', { seniorId });
  }
}

/**
 * Clear all caches
 */
function clearAll() {
  const count = cache.size;
  cache.clear();
  log.info('Cleared all cached contexts', { count });
}

/**
 * Run daily pre-fetch for seniors whose local time is at PREFETCH_HOUR
 * Called hourly by scheduler
 */
async function runDailyPrefetch() {
  log.info('Running daily pre-fetch check');

  try {
    // Get all seniors
    const seniors = await seniorService.list();

    let prefetchedCount = 0;
    for (const senior of seniors) {
      const localHour = getLocalHour(senior.timezone);

      // Pre-fetch if it's 5 AM in their timezone
      if (localHour === PREFETCH_HOUR) {
        await prefetchAndCache(senior.id);
        prefetchedCount++;
      }
    }

    if (prefetchedCount > 0) {
      log.info('Pre-fetched contexts', { count: prefetchedCount });
    }
  } catch (error) {
    log.error('Daily pre-fetch error', { error: error.message });
  }
}

/**
 * Get cache stats
 */
function getStats() {
  const now = Date.now();
  let validCount = 0;
  let expiredCount = 0;

  for (const [id, cached] of cache) {
    if (now > cached.expiresAt) {
      expiredCount++;
    } else {
      validCount++;
    }
  }

  return {
    total: cache.size,
    valid: validCount,
    expired: expiredCount
  };
}

export const contextCacheService = {
  prefetchAndCache,
  getCache,
  clearCache,
  clearAll,
  runDailyPrefetch,
  getStats,
  getLocalHour,
  generateGreeting,
  generateTemplatedGreeting,
  selectInterest,
  GREETING_TEMPLATES,
  FALLBACK_TEMPLATES
};

export default contextCacheService;
