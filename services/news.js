import OpenAI from 'openai';
import { createLogger } from '../lib/logger.js';

const log = createLogger('News');

// Initialize OpenAI client (lazy to avoid startup crash if key missing)
let openai = null;
const getOpenAI = () => {
  if (!openai && process.env.OPENAI_API_KEY) {
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openai;
};

// Simple in-memory cache
const newsCache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

const getCacheKey = (interests) => [...interests].sort().join('|').toLowerCase();

export const newsService = {
  /**
   * Fetch news relevant to senior's interests using OpenAI web search
   * @param {string[]} interests - Array of interest topics
   * @param {number} limit - Max number of news items
   * @returns {Promise<string|null>} Formatted news context or null
   */
  async getNewsForSenior(interests, limit = 3) {
    if (!interests?.length) {
      return null;
    }

    const client = getOpenAI();
    if (!client) {
      log.info('OpenAI not configured, skipping news fetch');
      return null;
    }

    // Check cache
    const cacheKey = getCacheKey(interests);
    const cached = newsCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      log.info('Using cached news', { interestsCount: interests.length });
      return cached.news;
    }

    try {
      log.info('Fetching news for interests', { interestsCount: interests.length });

      const interestList = interests.slice(0, 5).join(', ');
      const storyCount = Math.max(2, Math.min(limit, 10));

      const response = await client.responses.create({
        model: 'gpt-4o-mini',
        tools: [{ type: 'web_search_preview' }],
        input: `Find ${storyCount} brief, positive news stories from today about: ${interestList}.
                These are for an elderly person, so:
                - Choose uplifting or interesting stories (avoid distressing news)
                - Keep each summary to 1-2 sentences
                - Focus on human interest, health tips, local events, or hobby-related news

                Format as a simple list with bullet points.`,
        tool_choice: 'required',
      });

      const newsContent = response.output_text?.trim();

      if (!newsContent) {
        log.info('No news content returned');
        return null;
      }

      // Format for injection into context
      const formattedNews = this.formatNewsContext(newsContent);

      // Cache the result
      newsCache.set(cacheKey, {
        news: formattedNews,
        timestamp: Date.now()
      });

      log.info('Fetched and cached news successfully', { interestsCount: interests.length });
      return formattedNews;

    } catch (error) {
      log.error('Error fetching news', { error: error.message });
      return null;
    }
  },

  /**
   * Format news for natural conversation injection
   * @param {string} rawNews - Raw news from API
   * @returns {string} Formatted context string
   */
  formatNewsContext(rawNews) {
    return `Here are some recent news items you could mention naturally if the conversation allows:\n${rawNews}\n\nOnly bring these up if relevant to the conversation - don't force it.`;
  },

  /**
   * Clear the news cache (useful for testing)
   */
  clearCache() {
    newsCache.clear();
    log.info('Cache cleared');
  }
};
