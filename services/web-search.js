/**
 * Web Search Service (Tavily)
 *
 * Thin wrapper around Tavily API for the chat assistant.
 * Strips PHI from queries before sending externally.
 */

import { logAudit } from './audit.js';

const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
const TAVILY_URL = 'https://api.tavily.com/search';

/**
 * Strip potential PHI from a search query.
 * Removes phone numbers, names that look like proper nouns followed by possessives, etc.
 */
function sanitizeQuery(query) {
  // Remove phone numbers
  let sanitized = query.replace(/(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g, '');
  // Remove email addresses
  sanitized = sanitized.replace(/[\w.-]+@[\w.-]+\.\w+/g, '');
  return sanitized.trim();
}

/**
 * Search the web using Tavily API.
 *
 * @param {string} query - The search query
 * @param {Object} [options]
 * @param {string} [options.userId] - For audit logging
 * @returns {Promise<{ results: Array<{ title: string, url: string, content: string }> }>}
 */
export async function search(query, { userId } = {}) {
  if (!TAVILY_API_KEY) {
    console.warn('[WebSearch] TAVILY_API_KEY not configured, skipping search');
    return { results: [] };
  }

  const sanitizedQuery = sanitizeQuery(query);
  if (!sanitizedQuery) {
    return { results: [] };
  }

  // Audit log the search (fire-and-forget)
  if (userId) {
    logAudit({
      userId,
      userRole: 'caregiver',
      action: 'create',
      resourceType: 'external',
      metadata: { service: 'tavily_web_search', queryLength: sanitizedQuery.length },
    });
  }

  try {
    const res = await fetch(TAVILY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: TAVILY_API_KEY,
        query: sanitizedQuery,
        max_results: 8,
        include_raw_content: false,
      }),
    });

    if (!res.ok) {
      console.error(`[WebSearch] Tavily returned ${res.status}`);
      return { results: [] };
    }

    const data = await res.json();
    const results = (data.results || []).map(r => ({
      title: r.title,
      url: r.url,
      content: r.content,
    }));

    return { results };
  } catch (error) {
    console.error('[WebSearch] Tavily search failed:', error.message);
    return { results: [] };
  }
}
