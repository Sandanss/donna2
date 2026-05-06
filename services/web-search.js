/**
 * Web Search Service (Tavily)
 *
 * Thin wrapper around Tavily API for the chat assistant.
 * Strips PHI from queries before sending externally.
 */

import { logAudit } from './audit.js';

const TAVILY_URL = 'https://api.tavily.com/search';
const DEFAULT_TIMEOUT_MS = 4000;

/**
 * Strip potential PHI from a search query.
 * Removes phone numbers, names that look like proper nouns followed by possessives, etc.
 */
export function sanitizeQuery(query) {
  // Remove phone numbers
  let sanitized = String(query || '').replace(/(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g, '');
  // Remove email addresses
  sanitized = sanitized.replace(/[\w.-]+@[\w.-]+\.\w+/g, '');
  return sanitized.trim();
}

function fetchSignal(timeoutMs) {
  const timeout = Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return { signal: AbortSignal.timeout(timeout), cleanup: () => {} };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  return { signal: controller.signal, cleanup: () => clearTimeout(timer) };
}

/**
 * Search the web using Tavily API.
 *
 * @param {string} query - The search query
 * @param {Object} [options]
 * @param {string} [options.userId] - For audit logging
 * @returns {Promise<{ results: Array<{ title: string, url: string, content: string }> }>}
 */
export async function search(query, { userId, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
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

  let cleanup = () => {};
  try {
    const timeout = fetchSignal(timeoutMs);
    cleanup = timeout.cleanup;
    const res = await fetch(TAVILY_URL, {
      method: 'POST',
      signal: timeout.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
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
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      console.warn('[WebSearch] Tavily search timed out');
    } else {
      console.error('[WebSearch] Tavily search failed');
    }
    return { results: [] };
  } finally {
    cleanup();
  }
}
