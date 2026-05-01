import { db } from '../db/client.js';
import { conversations, seniors } from '../db/schema.js';
import { eq, desc, and, sql, inArray } from 'drizzle-orm';
import { createLogger } from '../lib/logger.js';
import { encrypt, decrypt, encryptJson, decryptJson } from '../lib/encryption.js';
import { callAnalysisService } from './call-analyses.js';

const log = createLogger('Conversation');

function decryptConversationFields(row) {
  const summary = row.summaryEncrypted ? decrypt(row.summaryEncrypted) : row.summary;
  const transcript = row.transcriptEncrypted ? decryptJson(row.transcriptEncrypted) : row.transcript;

  return {
    ...row,
    summary,
    transcript,
    summaryEncrypted: undefined,
    transcriptEncrypted: undefined,
    transcriptTextEncrypted: undefined,
  };
}

function decryptSummary(row) {
  return row.summaryEncrypted ? decrypt(row.summaryEncrypted) : row.summary;
}

const PLACEHOLDER_SUMMARIES = ['analysis unavailable', 'no summary available', 'summary unavailable'];

function isRealSummary(text) {
  if (!text) return false;
  return !PLACEHOLDER_SUMMARIES.includes(text.trim().toLowerCase());
}

async function addSummaryFallbacks(rows) {
  const analyses = await callAnalysisService.getLatestByConversationIds(rows.map(row => row.id));

  return rows.map(row => {
    const analysis = analyses.get(row.id) || null;
    const candidateSummary = decryptSummary(row) || analysis?.summary || null;
    const rawSummary = isRealSummary(candidateSummary) ? candidateSummary : null;
    const sentiment = row.sentiment || analysis?.sentiment || null;
    const direction = row.direction || null;

    // Compute displayStatus from direction + summary + duration
    let displayStatus;
    if (direction === 'inbound') {
      displayStatus = 'Inbound';
    } else if (!rawSummary && (row.durationSeconds == null || row.durationSeconds < 60)) {
      displayStatus = 'Missed';
    } else {
      displayStatus = 'Answered';
    }

    // Fallback summaries based on status and available data
    let summary = rawSummary;
    if (!summary) {
      if (displayStatus === 'Missed') {
        summary = null; // Frontend fills in with senior name
      } else if (displayStatus === 'Answered' && row.durationSeconds != null) {
        const mins = Math.round(row.durationSeconds / 60);
        if (row.durationSeconds < 120) {
          summary = `Donna spoke with them briefly (${mins} min) but a summary couldn\u2019t be generated.`;
        } else {
          summary = `Donna had a ${mins}-minute conversation but a summary couldn\u2019t be generated.`;
        }
      }
    }

    return {
      id: row.id,
      seniorId: row.seniorId,
      seniorName: row.seniorName,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      durationSeconds: row.durationSeconds,
      status: row.status,
      direction,
      displayStatus,
      summary,
      sentiment,
    };
  });
}

function contentToText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(block => block && block.type === 'text')
      .map(block => String(block.text || ''))
      .filter(text => !text.startsWith('[EPHEMERAL') && !text.startsWith('[Internal'))
      .join(' ');
  }
  return String(content);
}

export function formatTranscriptText(transcript) {
  if (transcript == null) return null;
  if (typeof transcript === 'string') {
    const text = transcript.trim();
    if (!text) return null;
    try {
      return formatTranscriptText(JSON.parse(text));
    } catch {
      return text;
    }
  }
  if (!Array.isArray(transcript)) {
    const text = String(transcript).trim();
    return text || null;
  }

  const lines = [];
  for (const turn of transcript) {
    if (!turn || typeof turn !== 'object') continue;
    const text = contentToText(turn.content).trim();
    if (!text || text.startsWith('[EPHEMERAL') || text.startsWith('[Internal')) continue;
    const role = String(turn.role || 'unknown').toLowerCase();
    const label = role === 'assistant' ? 'Donna' : role === 'user' ? 'Senior' : role.charAt(0).toUpperCase() + role.slice(1);
    lines.push(`${label}: ${text}`);
  }

  return lines.length ? lines.join('\n') : null;
}

export const conversationService = {
  // Create a new conversation record
  async create(data) {
    const [conversation] = await db.insert(conversations).values({
      seniorId: data.seniorId,
      callSid: data.callSid,
      startedAt: data.startedAt || new Date(),
      status: 'in_progress',
    }).returning();

    log.info('Created', { id: conversation.id, callSid: data.callSid });
    return conversation;
  },

  // Update conversation when call ends
  async complete(callSid, data) {
    const [conversation] = await db.update(conversations)
      .set({
        endedAt: new Date(),
        durationSeconds: data.durationSeconds,
        status: data.status || 'completed',
        summary: null,
        summaryEncrypted: encrypt(data.summary),
        transcriptEncrypted: encryptJson(data.transcript),
        transcriptTextEncrypted: encrypt(formatTranscriptText(data.transcript)),
        callMetrics: data.callMetrics,
        sentiment: data.sentiment,
        concerns: null,
      })
      .where(eq(conversations.callSid, callSid))
      .returning();

    if (conversation) {
      log.info('Completed', { id: conversation.id, durationSeconds: data.durationSeconds });
    }
    return conversation;
  },

  // Get conversation by call SID
  async getByCallSid(callSid) {
    const [conversation] = await db.select().from(conversations)
      .where(eq(conversations.callSid, callSid));
    return conversation || null;
  },

  // Get recent conversations for a senior
  async getForSenior(seniorId, limit = 10) {
    const rows = await db.select().from(conversations)
      .where(eq(conversations.seniorId, seniorId))
      .orderBy(desc(conversations.startedAt))
      .limit(limit);

    const analyses = await callAnalysisService.getLatestByConversationIds(rows.map(row => row.id));

    return rows.map(row => {
      const conversation = decryptConversationFields(row);
      const analysis = analyses.get(row.id) || null;
      return {
        ...conversation,
        summary: conversation.summary || analysis?.summary || null,
        analysis,
      };
    });
  },

  // Get summary-only call records for caregiver-facing views.
  async getCallSummariesForSenior(seniorId, limit = 10) {
    const rows = await db.select({
      id: conversations.id,
      seniorId: conversations.seniorId,
      startedAt: conversations.startedAt,
      endedAt: conversations.endedAt,
      durationSeconds: conversations.durationSeconds,
      status: conversations.status,
      direction: conversations.direction,
      summary: conversations.summary,
      summaryEncrypted: conversations.summaryEncrypted,
      sentiment: conversations.sentiment,
    })
    .from(conversations)
    .where(eq(conversations.seniorId, seniorId))
    .orderBy(desc(conversations.startedAt))
    .limit(limit);

    return addSummaryFallbacks(rows);
  },

  // Update conversation summary (called after post-call analysis)
  async updateSummary(callSid, summary, sentiment = undefined) {
    try {
      const update = { summary: null, summaryEncrypted: encrypt(summary) };
      if (sentiment !== undefined) update.sentiment = sentiment;

      const [conversation] = await db.update(conversations)
        .set(update)
        .where(eq(conversations.callSid, callSid))
        .returning();

      if (conversation) {
        log.info('Updated summary', { callSid });
      }
      return conversation;
    } catch (error) {
      log.error('Error updating summary', { callSid, error: error.message });
      return null;
    }
  },

  // Get recent call summaries for context (instead of raw messages)
  async getRecentSummaries(seniorId, limit = 3) {
    const recentCalls = await db.select({
      summary: conversations.summary,
      summaryEncrypted: conversations.summaryEncrypted,
      startedAt: conversations.startedAt,
      durationSeconds: conversations.durationSeconds,
    })
    .from(conversations)
    .where(and(
      eq(conversations.seniorId, seniorId),
      eq(conversations.status, 'completed'),
      sql`(summary IS NOT NULL OR summary_encrypted IS NOT NULL)`,
      sql`(COALESCE(summary, '') != '' OR summary_encrypted IS NOT NULL)`
    ))
    .orderBy(desc(conversations.startedAt))
    .limit(limit);

    if (recentCalls.length === 0) return null;

    // Format as context string
    const summaries = recentCalls.map(call => {
      const daysAgo = Math.floor((Date.now() - new Date(call.startedAt).getTime()) / (1000 * 60 * 60 * 24));
      const timeAgo = daysAgo === 0 ? 'Earlier today' : daysAgo === 1 ? 'Yesterday' : `${daysAgo} days ago`;
      const duration = call.durationSeconds ? `(${Math.round(call.durationSeconds / 60)} min)` : '';
      const summary = call.summaryEncrypted ? decrypt(call.summaryEncrypted) : call.summary;
      return `- ${timeAgo} ${duration}: ${summary}`;
    }).filter(s => !s.includes('[encrypted]'));

    return summaries.length ? summaries.join('\n') : null;
  },

  // Legacy: Get recent conversation history for context (across calls)
  // Deprecated: Use getRecentSummaries instead
  async getRecentHistory(seniorId, messageLimit = 6) {
    // Get last few completed conversations with transcripts
    const recentCalls = await db.select({
      transcript: conversations.transcript,
      transcriptEncrypted: conversations.transcriptEncrypted,
      startedAt: conversations.startedAt,
    })
    .from(conversations)
    .where(and(
      eq(conversations.seniorId, seniorId),
      eq(conversations.status, 'completed'),
      sql`(transcript IS NOT NULL OR transcript_encrypted IS NOT NULL)`
    ))
    .orderBy(desc(conversations.startedAt))
    .limit(2); // Last 2 calls

    if (recentCalls.length === 0) return [];

    // Extract messages from transcripts (most recent first)
    const allMessages = [];
    for (const call of recentCalls) {
      try {
        let transcript;
        if (call.transcriptEncrypted) {
          transcript = decryptJson(call.transcriptEncrypted);
        } else {
          transcript = typeof call.transcript === 'string'
            ? JSON.parse(call.transcript)
            : call.transcript;
        }

        if (Array.isArray(transcript)) {
          // Take last few messages from each call
          const messages = transcript.slice(-4).map(m => ({
            role: m.role,
            content: m.content,
            fromPreviousCall: true
          }));
          allMessages.push(...messages);
        }
      } catch (e) {
        // Skip malformed transcripts
      }
    }

    // Return most recent messages up to limit
    return allMessages.slice(-messageLimit);
  },

  // Get all recent conversations with senior names
  async getRecent(limit = 20) {
    const results = await db.select({
      id: conversations.id,
      seniorId: conversations.seniorId,
      callSid: conversations.callSid,
      startedAt: conversations.startedAt,
      endedAt: conversations.endedAt,
      durationSeconds: conversations.durationSeconds,
      status: conversations.status,
      summary: conversations.summary,
      summaryEncrypted: conversations.summaryEncrypted,
      sentiment: conversations.sentiment,
      concerns: conversations.concerns,
      transcript: conversations.transcript,
      transcriptEncrypted: conversations.transcriptEncrypted,
      seniorName: seniors.name,
    })
    .from(conversations)
    .leftJoin(seniors, eq(conversations.seniorId, seniors.id))
    .orderBy(desc(conversations.startedAt))
    .limit(limit);

    // Decrypt PHI fields for admin view
    return results.map(r => ({
      ...decryptConversationFields(r),
    }));
  },

  // Get recent summary-only call records scoped to authorized senior IDs.
  async getRecentCallSummariesForSeniors(seniorIds, limit = 20) {
    if (!seniorIds?.length) return [];

    const rows = await db.select({
      id: conversations.id,
      seniorId: conversations.seniorId,
      seniorName: seniors.name,
      startedAt: conversations.startedAt,
      endedAt: conversations.endedAt,
      durationSeconds: conversations.durationSeconds,
      status: conversations.status,
      direction: conversations.direction,
      summary: conversations.summary,
      summaryEncrypted: conversations.summaryEncrypted,
      sentiment: conversations.sentiment,
    })
    .from(conversations)
    .leftJoin(seniors, eq(conversations.seniorId, seniors.id))
    .where(inArray(conversations.seniorId, seniorIds))
    .orderBy(desc(conversations.startedAt))
    .limit(limit);

    return addSummaryFallbacks(rows);
  }
};
