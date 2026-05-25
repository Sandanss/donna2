import OpenAI from 'openai';
import { db } from '../db/client.js';
import { memories } from '../db/schema.js';
import { eq, sql, desc, and, inArray, lt } from 'drizzle-orm';
import { newsService } from './news.js';
import { createLogger } from '../lib/logger.js';
import { encrypt, decrypt } from '../lib/encryption.js';

const log = createLogger('Memory');

// Memory decay constants
const DECAY_HALF_LIFE_DAYS = 30; // Importance halves every 30 days
const ACCESS_BOOST = 10; // Boost importance by 10 per access
const MAX_IMPORTANCE = 100;
const ARCHIVE_THRESHOLD_DAYS = 90; // Consider archiving after 90 days without access
const ALLOWED_MEMORY_TYPES = new Set(['fact', 'preference', 'event', 'relationship', 'family', 'interest', 'routine']);

let openai = null;
const getOpenAI = () => {
  if (!openai) {
    if (!process.env.OPENAI_API_KEY) {
      log.warn('OPENAI_API_KEY not set - memory features disabled');
      return null;
    }
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openai;
};

// Calculate effective importance with decay
function calculateEffectiveImportance(baseImportance, createdAt, lastAccessedAt) {
  const now = Date.now();
  const ageMs = now - new Date(createdAt).getTime();
  const daysSinceCreation = ageMs / (1000 * 60 * 60 * 24);

  // Apply exponential decay: importance * 0.5^(days/half_life)
  const decayFactor = Math.pow(0.5, daysSinceCreation / DECAY_HALF_LIFE_DAYS);
  let effective = baseImportance * decayFactor;

  // Boost for recent access (reduces decay effect)
  if (lastAccessedAt) {
    const daysSinceAccess = (now - new Date(lastAccessedAt).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceAccess < 7) {
      // Accessed in last week - significant boost
      effective = Math.min(MAX_IMPORTANCE, effective + ACCESS_BOOST * (1 - daysSinceAccess / 7));
    }
  }

  return Math.round(effective);
}

/**
 * Decrypt content in memory rows: prefer contentEncrypted, fall back to content.
 * Mutates the rows in place and removes the contentEncrypted field.
 */
function decryptMemoryRows(rows) {
  for (const r of rows) {
    if (r.contentEncrypted) {
      r.content = decrypt(r.contentEncrypted);
    }
    delete r.contentEncrypted;
  }
  return rows;
}

export const memoryService = {
  // Generate embedding for text using OpenAI
  async generateEmbedding(text) {
    const client = getOpenAI();
    if (!client) return null;
    try {
      const response = await client.embeddings.create({
        model: 'text-embedding-3-small',
        input: text,
      });
      return response.data[0].embedding;
    } catch (error) {
      log.error('Embedding generation failed', { error: error.message });
      return null;
    }
  },

  // Store a new memory with embedding (with deduplication)
  async store(seniorId, type, content, source = null, importance = 50, metadata = null) {
    const embedding = await this.generateEmbedding(content);
    if (!embedding) {
      log.info('Skipping store - OpenAI not configured');
      return null;
    }

    // Deduplication: Check if similar memory already exists (cosine similarity > 0.9)
    const duplicates = await db.execute(sql`
      SELECT id, content, importance,
        1 - (embedding <=> ${JSON.stringify(embedding)}::vector) as similarity
      FROM memories
      WHERE senior_id = ${seniorId}
        AND 1 - (embedding <=> ${JSON.stringify(embedding)}::vector) > 0.9
      ORDER BY similarity DESC
      LIMIT 1
    `);

    if (duplicates.rows.length > 0) {
      const existing = duplicates.rows[0];
      log.info('Dedup: similar to existing', {
        seniorRef: String(seniorId).slice(0, 8),
        type,
        similarity: `${(existing.similarity * 100).toFixed(0)}%`,
      });

      // If new memory is more important, update the existing one
      if (importance > existing.importance) {
        await db.update(memories)
          .set({ importance, lastAccessedAt: new Date() })
          .where(eq(memories.id, existing.id));
        log.info('Updated importance', { from: existing.importance, to: importance });
      }
      return null; // Don't store duplicate
    }

    const [memory] = await db.insert(memories).values({
      seniorId,
      type,
      content: '[encrypted]',
      contentEncrypted: encrypt(content),
      source,
      importance,
      embedding,
      metadata,
    }).returning();

    log.info('Stored', { seniorRef: String(seniorId).slice(0, 8), type, contentLength: content.length });
    return decryptMemoryRows([memory])[0];
  },

  // Semantic search - find memories similar to query
  async search(seniorId, query, limit = 5, minSimilarity = 0.7) {
    const queryEmbedding = await this.generateEmbedding(query);
    if (!queryEmbedding) return [];

    const results = await db.execute(sql`
      SELECT
        id,
        type,
        content,
        content_encrypted,
        importance,
        metadata,
        created_at,
        1 - (embedding <=> ${JSON.stringify(queryEmbedding)}::vector) as similarity
      FROM memories
      WHERE senior_id = ${seniorId}
        AND 1 - (embedding <=> ${JSON.stringify(queryEmbedding)}::vector) > ${minSimilarity}
      ORDER BY embedding <=> ${JSON.stringify(queryEmbedding)}::vector
      LIMIT ${limit}
    `);

    // Update last accessed time for retrieved memories
    if (results.rows.length > 0) {
      const ids = results.rows.map(r => r.id);
      await db.update(memories)
        .set({ lastAccessedAt: new Date() })
        .where(inArray(memories.id, ids));
    }

    // Decrypt content: prefer encrypted column, fall back to original
    return results.rows.map(r => {
      const row = { ...r };
      if (row.content_encrypted) {
        row.content = decrypt(row.content_encrypted);
      }
      delete row.content_encrypted;
      return row;
    });
  },

  // Get recent memories for a senior
  async getRecent(seniorId, limit = 10) {
    const rows = await db.select().from(memories)
      .where(eq(memories.seniorId, seniorId))
      .orderBy(desc(memories.createdAt))
      .limit(limit);
    return decryptMemoryRows(rows);
  },

  // Get important memories for a senior (with decay applied)
  async getImportant(seniorId, limit = 5) {
    // Get more memories and filter by effective importance
    const allImportant = await db.select().from(memories)
      .where(and(
        eq(memories.seniorId, seniorId),
        sql`importance >= 50` // Lower threshold, will filter by effective
      ))
      .orderBy(desc(memories.importance))
      .limit(limit * 3); // Get more to account for decay filtering

    decryptMemoryRows(allImportant);

    // Calculate effective importance and filter/sort
    const withEffective = allImportant.map(m => ({
      ...m,
      effectiveImportance: calculateEffectiveImportance(m.importance, m.createdAt, m.lastAccessedAt)
    }));

    return withEffective
      .filter(m => m.effectiveImportance >= 50) // Min 50 effective importance
      .sort((a, b) => b.effectiveImportance - a.effectiveImportance)
      .slice(0, limit);
  },

  // Get high-importance memories - Tier 1
  async getCritical(seniorId, limit = 3) {
    const rows = await db.select().from(memories)
      .where(and(
        eq(memories.seniorId, seniorId),
        sql`importance >= 80`
      ))
      .orderBy(desc(memories.importance))
      .limit(limit);
    return decryptMemoryRows(rows);
  },

  // Group memories by type for compact display
  groupByType(memories) {
    const groups = {};
    for (const m of memories) {
      const type = m.type || 'fact';
      if (!groups[type]) groups[type] = [];
      groups[type].push(m.content);
    }
    return groups;
  },

  // Format grouped memories compactly
  formatGroupedMemories(groups) {
    const typeLabels = {
      relationship: 'Family/Friends',
      family: 'Family/Friends',
      preference: 'Preferences',
      event: 'Recent events',
      interest: 'Interests',
      routine: 'Routines',
      fact: 'Facts'
    };

    const lines = [];
    for (const [type, contents] of Object.entries(groups)) {
      const label = typeLabels[type] || type;
      // For relationships, join with semicolon. Others with comma.
      const separator = type === 'relationship' ? '; ' : ', ';
      lines.push(`${label}: ${contents.join(separator)}`);
    }
    return lines.join('\n');
  },

  // Build context string for conversation using tiered injection
  // Tier 1: High-importance memories - always included
  // Tier 2 (Contextual): Relevant to current topic - included when topic provided
  // Tier 3 (Background): General facts - included on first turn only
  async buildContext(seniorId, currentTopic = null, senior = null, isFirstTurn = true) {
    const contextParts = [];
    const includedIds = new Set(); // Track included memories to avoid duplicates

    // Tier 1: Critical memories (always include)
    const critical = await this.getCritical(seniorId, 3);
    if (critical.length > 0) {
      contextParts.push('Critical to know:');
      critical.forEach(m => {
        contextParts.push(`- ${m.content}`);
        includedIds.add(m.id);
      });
    }

    // Tier 2: Contextual memories (when topic provided)
    if (currentTopic) {
      const relevant = await this.search(seniorId, currentTopic, 3, 0.7);
      const newRelevant = relevant.filter(m => !includedIds.has(m.id));
      if (newRelevant.length > 0) {
        contextParts.push('\nRelevant:');
        newRelevant.forEach(m => {
          contextParts.push(`- ${m.content}`);
          includedIds.add(m.id);
        });
      }
    }

    // Tier 3: Background memories (first turn only) - grouped by type for compactness
    if (isFirstTurn) {
      const backgroundMemories = [];

      // Get important memories not already included
      const important = await this.getImportant(seniorId, 5);
      const newImportant = important.filter(m => !includedIds.has(m.id));
      backgroundMemories.push(...newImportant);
      newImportant.forEach(m => includedIds.add(m.id));

      // Get recent memories not already included
      const recent = await this.getRecent(seniorId, 5);
      const newRecent = recent.filter(m => !includedIds.has(m.id));
      backgroundMemories.push(...newRecent);

      // Group and format compactly
      if (backgroundMemories.length > 0) {
        const groups = this.groupByType(backgroundMemories);
        const formatted = this.formatGroupedMemories(groups);
        contextParts.push('\nBackground:\n' + formatted);
      }
    }

    // Fetch news based on senior's interests (first turn only)
    if (isFirstTurn && senior?.interests?.length) {
      try {
        const newsContext = await newsService.getNewsForSenior(senior.interests);
        if (newsContext) {
          contextParts.push('\n' + newsContext);
        }
      } catch (error) {
        log.error('Error fetching news', { error: error.message });
      }
    }

    return contextParts.join('\n');
  },

  // Extract and store memories from conversation
  async extractFromConversation(seniorId, transcript, conversationId) {
    // Use Gemini/OpenAI to extract facts and memories from transcript
    // This is called after a conversation ends

    const prompt = `Analyze this conversation and extract important facts, preferences, events, relationships, family details, interests, or routines about the person. Return a JSON array of memories.

Do not extract medical, health, safety, or care concerns. Donna is a companion product, not a medical monitoring product.

Conversation:
${transcript}

Return format:
[
  {"type": "fact|preference|event|relationship|family|interest|routine", "content": "...", "importance": 50-100}
]

Only include genuinely important or memorable information. Be concise.`;

    try {
      const client = getOpenAI();
      if (!client) {
        log.info('Skipping extraction - OpenAI not configured');
        return;
      }
      const response = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' }
      });

      const result = JSON.parse(response.choices[0].message.content);
      const memoriesArray = result.memories || result;

      if (Array.isArray(memoriesArray)) {
        for (const mem of memoriesArray) {
          if (!mem.content) continue;
          const type = ALLOWED_MEMORY_TYPES.has(mem.type) ? mem.type : 'fact';
          await this.store(
            seniorId,
            type,
            mem.content,
            conversationId,
            mem.importance || 50
          );
        }
        log.info('Extracted memories from conversation', { count: memoriesArray.length });
      }
    } catch (error) {
      log.error('Failed to extract memories', { error: error.message });
    }
  }
};
