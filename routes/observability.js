import { Router } from 'express';
import { db } from '../db/client.js';
import { seniors, conversations } from '../db/schema.js';
import { eq, desc, and, sql } from 'drizzle-orm';
import { requireAdmin } from '../middleware/auth.js';
import { decrypt, decryptJson } from '../lib/encryption.js';
import { callAnalysisService } from '../services/call-analyses.js';
import { getDatabaseScalingSnapshot } from '../services/db-observability.js';
import { routeError } from './helpers.js';
import { logAudit, authToRole } from '../services/audit.js';

const router = Router();

function readSummary(call, analysis = null) {
  const summary = call.summaryEncrypted ? decrypt(call.summaryEncrypted) : call.summary;
  return summary || analysis?.summary || null;
}

function readTranscript(call) {
  return call.transcriptEncrypted ? decryptJson(call.transcriptEncrypted) : call.transcript;
}

function readConcerns(call, analysis = null) {
  if (Array.isArray(call.concerns) && call.concerns.length > 0) return call.concerns;
  return Array.isArray(analysis?.concerns) ? analysis.concerns : [];
}

function readJsonObject(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }
  return typeof value === 'object' ? value : null;
}

function readLatency(metric) {
  return readJsonObject(metric?.latency) || {};
}

function readLatencyBreakdown(metric) {
  const latency = readLatency(metric);
  const breakdown = latency?.stage_breakdown;
  return breakdown && typeof breakdown === 'object' && !Array.isArray(breakdown) ? breakdown : {};
}

function pickLatencyBreakdown(traceBreakdown, fallbackBreakdown) {
  return traceBreakdown && Object.keys(traceBreakdown).length > 0
    ? traceBreakdown
    : fallbackBreakdown;
}

function readContextTrace(metric) {
  const fallbackBreakdown = readLatencyBreakdown(metric);
  let trace = null;
  if (metric?.context_trace_encrypted) {
    try {
      trace = decryptJson(metric.context_trace_encrypted);
    } catch {
      trace = null;
    }
  }
  if (!trace) {
    return Object.keys(fallbackBreakdown).length > 0
      ? { version: 1, event_count: 0, latency_breakdown: fallbackBreakdown, events: [] }
      : null;
  }
  if (Array.isArray(trace)) {
    return {
      version: 1,
      event_count: trace.length,
      latency_breakdown: fallbackBreakdown,
      events: trace,
    };
  }
  if (!Array.isArray(trace.events)) {
    return {
      ...trace,
      event_count: 0,
      latency_breakdown: pickLatencyBreakdown(trace.latency_breakdown, fallbackBreakdown),
      events: [],
    };
  }
  return {
    version: trace.version || 1,
    captured_at: trace.captured_at || null,
    event_count: trace.event_count ?? trace.events.length,
    latency_breakdown: pickLatencyBreakdown(trace.latency_breakdown, fallbackBreakdown),
    events: trace.events,
  };
}

function isUndefinedColumnError(error) {
  return error?.code === '42703'
    || error?.cause?.code === '42703'
    || /context_trace_encrypted|column .* does not exist/i.test(error?.message || '');
}

async function fetchLatestInfraMetric(callSid, includeContextTrace = true) {
  if (!callSid) return null;
  if (includeContextTrace) {
    try {
      const rows = await db.execute(sql`
        SELECT call_sid, senior_id, call_type, duration_seconds,
               end_reason, turn_count, phase_durations, latency,
               breaker_states, tools_used, token_usage, error_count,
               context_trace_encrypted, created_at
        FROM call_metrics
        WHERE call_sid = ${callSid}
        ORDER BY created_at DESC
        LIMIT 1
      `);
      return rows.rows[0] || null;
    } catch (error) {
      if (!isUndefinedColumnError(error)) throw error;
    }
  }

  const rows = await db.execute(sql`
    SELECT call_sid, senior_id, call_type, duration_seconds,
           end_reason, turn_count, phase_durations, latency,
           breaker_states, tools_used, token_usage, error_count,
           created_at
    FROM call_metrics
    WHERE call_sid = ${callSid}
    ORDER BY created_at DESC
    LIMIT 1
  `);
  return rows.rows[0] || null;
}

function toMs(value) {
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function readTurnSequence(turn, fallback) {
  const sequence = Number(turn?.sequence);
  return Number.isFinite(sequence) ? sequence : fallback;
}

function readTurnOffsetMs(turn) {
  const offset = Number(turn?.timestamp_offset_ms ?? turn?.timestampOffsetMs);
  return Number.isFinite(offset) && offset >= 0 ? offset : null;
}

function readTurnTimestamp(call, turn, index, totalTurns) {
  const explicitMs = toMs(turn?.timestamp);
  if (explicitMs != null) {
    return { timestamp: new Date(explicitMs).toISOString(), estimated: false };
  }

  const startedMs = toMs(call.startedAt);
  if (startedMs == null) {
    return { timestamp: call.startedAt, estimated: true };
  }

  const offsetMs = readTurnOffsetMs(turn);
  if (offsetMs != null) {
    return { timestamp: new Date(startedMs + offsetMs).toISOString(), estimated: false };
  }

  const endedMs = toMs(call.endedAt);
  const durationMs = Number(call.durationSeconds) > 0
    ? Number(call.durationSeconds) * 1000
    : endedMs != null && endedMs > startedMs
      ? endedMs - startedMs
      : Math.max(totalTurns, 1) * 12000;
  const estimatedOffset = Math.round(((index + 1) / (totalTurns + 1)) * durationMs);
  return { timestamp: new Date(startedMs + estimatedOffset).toISOString(), estimated: true };
}

function readContextEventTimestamp(call, event) {
  const explicitMs = toMs(event?.timestamp);
  if (explicitMs != null) {
    return { timestamp: new Date(explicitMs).toISOString(), estimated: false };
  }

  const startedMs = toMs(call.startedAt);
  if (startedMs == null) {
    return { timestamp: call.startedAt, estimated: true };
  }

  const offsetMs = Number(event?.timestamp_offset_ms ?? event?.timestampOffsetMs);
  if (Number.isFinite(offsetMs) && offsetMs >= 0) {
    return { timestamp: new Date(startedMs + offsetMs).toISOString(), estimated: false };
  }

  return { timestamp: call.startedAt, estimated: true };
}

function contextEventTimelineType(event) {
  const source = String(event?.source || '').toLowerCase();
  const stage = String(event?.metadata?.stage || '').toLowerCase();

  if (source === 'call_lifecycle') {
    return stage === 'call.answer_to_ws' ? 'call.connected' : 'call.lifecycle';
  }
  if (stage.startsWith('tool.')) return 'latency.tool';
  if (stage.startsWith('director.')) return 'latency.director';
  if (stage.startsWith('prefetch.') || stage.startsWith('memory_gate.')) return 'latency.memory';
  if (stage.startsWith('transcription.')) return 'latency.transcription';
  if (stage === 'llm_ttfb') return 'latency.llm';
  if (stage === 'tts_ttfb') return 'latency.tts';
  if (stage === 'turn.total') return 'latency.turn';
  if (source.includes('tool')) return 'latency.tool';
  return 'latency.stage';
}

function shouldIncludeContextTimelineEvent(event) {
  if (!event) return false;
  const source = String(event.source || '').toLowerCase();
  const action = String(event.action || '').toLowerCase();
  const stage = String(event?.metadata?.stage || '').toLowerCase();

  return source === 'call_lifecycle'
    || event.latency_ms != null
    || stage !== ''
    || action === 'called'
    || action === 'result'
    || action === 'failed';
}

function buildContextTimelineEvents(call, contextTrace) {
  const events = Array.isArray(contextTrace?.events) ? contextTrace.events : [];
  return events
    .filter(shouldIncludeContextTimelineEvent)
    .map((event) => {
      const { timestamp, estimated } = readContextEventTimestamp(call, event);
      return {
        type: contextEventTimelineType(event),
        timestamp,
        data: {
          label: event.label,
          source: event.source,
          action: event.action,
          provider: event.provider,
          stage: event?.metadata?.stage || null,
          latencyMs: event.latency_ms ?? null,
          turnSequence: event.turn_sequence ?? null,
          itemCount: event.item_count ?? null,
          content: event.content || null,
          estimatedTimestamp: estimated,
        },
        metadata: event.metadata || {},
      };
    });
}

function auditObservabilityRead(req, resourceId = null, metadata = {}) {
  logAudit({
    userId: req.auth.userId,
    userRole: authToRole(req.auth),
    action: 'read',
    resourceType: 'conversation',
    resourceId,
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
    metadata: { surface: 'observability', ...metadata },
  });
}

// One-time cleanup: mark stale in_progress calls (older than 1 hour) as completed
db.update(conversations)
  .set({ status: 'completed', endedAt: sql`COALESCE(ended_at, started_at + interval '1 minute')` })
  .where(and(
    eq(conversations.status, 'in_progress'),
    sql`started_at < NOW() - interval '1 hour'`
  ))
  .then(result => {
    if (result.rowCount > 0) {
      console.log(`[Observability] Cleaned up ${result.rowCount} stale in_progress calls`);
    }
  })
  .catch(err => console.error('[Observability] Cleanup error:', err.message));

// Get recent calls for observability dashboard
router.get('/api/observability/calls', requireAdmin, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const calls = await db.select({
      id: conversations.id,
      callSid: conversations.callSid,
      seniorId: conversations.seniorId,
      seniorName: seniors.name,
      seniorPhone: seniors.phone,
      startedAt: conversations.startedAt,
      endedAt: conversations.endedAt,
      durationSeconds: conversations.durationSeconds,
      status: conversations.status,
      summary: conversations.summary,
      summaryEncrypted: conversations.summaryEncrypted,
      sentiment: conversations.sentiment,
      concerns: conversations.concerns,
      callMetrics: conversations.callMetrics,
      transcript: conversations.transcript,
      transcriptEncrypted: conversations.transcriptEncrypted,
    })
    .from(conversations)
    .leftJoin(seniors, eq(conversations.seniorId, seniors.id))
    .orderBy(desc(conversations.startedAt))
    .limit(limit);

    const analyses = await callAnalysisService.getLatestByConversationIds(calls.map(call => call.id));

    // Transform to match dashboard expected format
    const formattedCalls = calls.map(call => {
      const analysis = analyses.get(call.id) || null;
      const transcript = readTranscript(call);
      return {
        id: call.id,
        call_sid: call.callSid,
        senior_id: call.seniorId,
        senior_name: call.seniorName,
        senior_phone: call.seniorPhone,
        started_at: call.startedAt,
        ended_at: call.endedAt,
        duration_seconds: call.durationSeconds,
        status: call.status || 'completed',
        summary: readSummary(call, analysis),
        sentiment: call.sentiment,
        concerns: readConcerns(call, analysis),
        call_metrics: call.callMetrics || null,
        turn_count: Array.isArray(transcript) ? transcript.length : 0,
        analysis,
      };
    });

    auditObservabilityRead(req, null, { endpoint: 'calls', limit, count: formattedCalls.length });
    res.json({ calls: formattedCalls });
  } catch (error) {
    routeError(res, error, 'GET /api/observability/calls');
  }
});

// Get active calls — voice sessions are tracked by Pipecat, not Node.js
router.get('/api/observability/active', requireAdmin, async (req, res) => {
  try {
    const active = await db.select({
      id: conversations.id,
      callSid: conversations.callSid,
      seniorId: conversations.seniorId,
      seniorName: seniors.name,
      seniorPhone: seniors.phone,
      startedAt: conversations.startedAt,
      endedAt: conversations.endedAt,
      durationSeconds: conversations.durationSeconds,
      status: conversations.status,
      transcript: conversations.transcript,
      transcriptEncrypted: conversations.transcriptEncrypted,
    })
    .from(conversations)
    .leftJoin(seniors, eq(conversations.seniorId, seniors.id))
    .where(and(
      eq(conversations.status, 'in_progress'),
      sql`started_at >= NOW() - interval '2 hours'`
    ))
    .orderBy(desc(conversations.startedAt))
    .limit(20);

    const activeCalls = active.map(call => {
      const transcript = readTranscript(call);
      return {
        id: call.id,
        call_sid: call.callSid,
        senior_id: call.seniorId,
        senior_name: call.seniorName,
        senior_phone: call.seniorPhone,
        started_at: call.startedAt,
        ended_at: call.endedAt,
        duration_seconds: call.durationSeconds,
        status: call.status,
        turn_count: Array.isArray(transcript) ? transcript.length : 0,
      };
    });

    auditObservabilityRead(req, null, { endpoint: 'active', count: activeCalls.length });
    res.json({ activeCalls });
  } catch (error) {
    routeError(res, error, 'GET /api/observability/active');
  }
});

// Get call details by ID
router.get('/api/observability/calls/:id', requireAdmin, async (req, res) => {
  try {
    const [call] = await db.select({
      id: conversations.id,
      callSid: conversations.callSid,
      seniorId: conversations.seniorId,
      seniorName: seniors.name,
      seniorPhone: seniors.phone,
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
    })
    .from(conversations)
    .leftJoin(seniors, eq(conversations.seniorId, seniors.id))
    .where(eq(conversations.id, req.params.id));

    if (!call) {
      return res.status(404).json({ error: 'Call not found' });
    }

    const analyses = await callAnalysisService.getLatestByConversationIds([call.id]);
    const analysis = analyses.get(call.id) || null;
    const transcript = readTranscript(call);

    auditObservabilityRead(req, call.id, {
      endpoint: 'call_detail',
      seniorId: call.seniorId,
      includesTranscript: Boolean(transcript),
    });
    res.json({
      id: call.id,
      call_sid: call.callSid,
      senior_id: call.seniorId,
      senior_name: call.seniorName,
      senior_phone: call.seniorPhone,
      started_at: call.startedAt,
      ended_at: call.endedAt,
      duration_seconds: call.durationSeconds,
      status: call.status || 'completed',
      summary: readSummary(call, analysis),
      sentiment: call.sentiment,
      concerns: readConcerns(call, analysis),
      transcript,
      analysis,
    });
  } catch (error) {
    routeError(res, error, 'GET /api/observability/calls/:id');
  }
});

// Get call timeline (events from transcript)
router.get('/api/observability/calls/:id/timeline', requireAdmin, async (req, res) => {
  try {
    const [call] = await db.select({
      id: conversations.id,
      callSid: conversations.callSid,
      seniorId: conversations.seniorId,
      startedAt: conversations.startedAt,
      endedAt: conversations.endedAt,
      durationSeconds: conversations.durationSeconds,
      status: conversations.status,
      transcript: conversations.transcript,
      transcriptEncrypted: conversations.transcriptEncrypted,
    })
    .from(conversations)
    .where(eq(conversations.id, req.params.id));

    if (!call) {
      return res.status(404).json({ error: 'Call not found' });
    }

    const infraMetric = await fetchLatestInfraMetric(call.callSid);
    const contextTrace = readContextTrace(infraMetric);

    // Build timeline from transcript
    const timeline = [];
    const transcript = readTranscript(call);

    // Add call start event
    timeline.push({
      type: 'call.initiated',
      timestamp: call.startedAt,
      data: { callSid: call.callSid },
    });

    // Add transcript events if available
    if (Array.isArray(transcript)) {
      const orderedTranscript = transcript
        .map((turn, index) => ({ turn, originalIndex: index, sequence: readTurnSequence(turn, index) }))
        .sort((a, b) => a.sequence - b.sequence || a.originalIndex - b.originalIndex);

      orderedTranscript.forEach(({ turn, originalIndex }, index) => {
        const { timestamp, estimated } = readTurnTimestamp(call, turn, index, orderedTranscript.length);
        const baseData = {
          content: turn.content,
          turnIndex: originalIndex,
          sequence: readTurnSequence(turn, originalIndex),
          estimatedTimestamp: estimated,
        };
        if (turn.role === 'user') {
          timeline.push({
            type: 'turn.transcribed',
            timestamp,
            data: baseData,
          });
        } else if (turn.role === 'assistant') {
          timeline.push({
            type: 'turn.response',
            timestamp,
            data: baseData,
          });
        }
        // Add observer signals if present
        if (turn.observer) {
          timeline.push({
            type: 'observer.signal',
            timestamp,
            data: { ...turn.observer, turnIndex: originalIndex, estimatedTimestamp: estimated },
          });
        }
      });
    }

    // Add call end event
    if (call.endedAt) {
      timeline.push({
        type: 'call.ended',
        timestamp: call.endedAt,
        data: { durationSeconds: call.durationSeconds },
      });
    }

    timeline.push(...buildContextTimelineEvents(call, contextTrace));

    const orderedTimeline = timeline
      .map((event, index) => ({ event, index }))
      .sort((a, b) => {
        const aMs = toMs(a.event.timestamp) ?? 0;
        const bMs = toMs(b.event.timestamp) ?? 0;
        return aMs - bMs || a.index - b.index;
      })
      .map(({ event }) => event);

    auditObservabilityRead(req, call.id, {
      endpoint: 'timeline',
      seniorId: call.seniorId,
      eventCount: orderedTimeline.length,
    });
    res.json({
      callId: call.id,
      callSid: call.callSid,
      seniorId: call.seniorId,
      startedAt: call.startedAt,
      endedAt: call.endedAt,
      status: call.status || 'completed',
      timeline: orderedTimeline,
    });
  } catch (error) {
    routeError(res, error, 'GET /api/observability/calls/:id/timeline');
  }
});

// Get call turns (conversation turns)
router.get('/api/observability/calls/:id/turns', requireAdmin, async (req, res) => {
  try {
    const [call] = await db.select({
      transcript: conversations.transcript,
      transcriptEncrypted: conversations.transcriptEncrypted,
    })
    .from(conversations)
    .where(eq(conversations.id, req.params.id));

    if (!call) {
      return res.status(404).json({ error: 'Call not found' });
    }

    const transcript = readTranscript(call);
    const turns = (Array.isArray(transcript) ? transcript : []).map((turn, index) => ({
      id: index,
      role: turn.role,
      content: turn.content,
      timestamp: turn.timestamp,
    }));

    auditObservabilityRead(req, req.params.id, {
      endpoint: 'turns',
      turnCount: turns.length,
    });
    res.json({ turns });
  } catch (error) {
    routeError(res, error, 'GET /api/observability/calls/:id/turns');
  }
});

// Get observer signals for a call
router.get('/api/observability/calls/:id/observer', requireAdmin, async (req, res) => {
  try {
    const [call] = await db.select({
      id: conversations.id,
      transcript: conversations.transcript,
      transcriptEncrypted: conversations.transcriptEncrypted,
      concerns: conversations.concerns,
      sentiment: conversations.sentiment,
    })
    .from(conversations)
    .where(eq(conversations.id, req.params.id));

    if (!call) {
      return res.status(404).json({ error: 'Call not found' });
    }

    // Extract observer signals from transcript
    const signals = [];
    const engagementDistribution = {};
    const emotionalStateDistribution = {};
    const allConcerns = [];
    let totalConfidence = 0;

    const transcript = readTranscript(call);
    if (Array.isArray(transcript)) {
      transcript.forEach((turn, index) => {
        if (turn.observer) {
          const engagementLevel = turn.observer.engagement_level || turn.observer.engagementLevel || 'medium';
          const emotionalState = turn.observer.emotional_state || turn.observer.emotionalState || 'neutral';
          const confidenceScore = turn.observer.confidence_score || turn.observer.confidenceScore || 0.5;
          const concerns = turn.observer.concerns || [];

          signals.push({
            turnId: String(index),
            speaker: turn.role === 'user' ? 'Senior' : 'Donna',
            turnContent: turn.content || '',
            timestamp: turn.timestamp,
            signal: {
              engagementLevel,
              emotionalState,
              confidenceScore,
              concerns,
              shouldDeliverReminder: turn.observer.should_deliver_reminder || turn.observer.shouldDeliverReminder || false,
              shouldEndCall: turn.observer.should_end_call || turn.observer.shouldEndCall || false,
            },
          });

          engagementDistribution[engagementLevel] = (engagementDistribution[engagementLevel] || 0) + 1;
          emotionalStateDistribution[emotionalState] = (emotionalStateDistribution[emotionalState] || 0) + 1;
          totalConfidence += confidenceScore;
          allConcerns.push(...concerns);
        }
      });
    }

    const uniqueConcerns = [...new Set([...allConcerns, ...(call.concerns || [])])];
    const analyses = await callAnalysisService.getLatestByConversationIds([call.id]);
    const analysis = analyses.get(call.id) || null;
    const analysisConcerns = Array.isArray(analysis?.concerns) ? analysis.concerns : [];
    const allUniqueConcerns = [
      ...new Set([...uniqueConcerns, ...analysisConcerns.map(concern => (
        typeof concern === 'string'
          ? concern
          : concern?.description || concern?.concern || concern?.text || 'Concern noted'
      ))]),
    ];

    auditObservabilityRead(req, req.params.id, {
      endpoint: 'observer',
      signalCount: signals.length,
    });
    res.json({
      signals,
      count: signals.length,
      summary: {
        averageConfidence: signals.length > 0 ? totalConfidence / signals.length : 0,
        engagementDistribution,
        emotionalStateDistribution,
        totalConcerns: allUniqueConcerns.length,
        uniqueConcerns: allUniqueConcerns,
      },
      postCall: analysis ? {
        sentiment: call.sentiment || analysis.sentiment || null,
        mood: analysis.mood || null,
        engagementScore: analysis.engagementScore ?? null,
        topics: analysis.topics || [],
        concerns: analysisConcerns,
        positiveObservations: analysis.positiveObservations || [],
        followUpSuggestions: analysis.followUpSuggestions || [],
        caregiverTakeaways: analysis.caregiverTakeaways || [],
        recommendedCaregiverAction: analysis.recommendedCaregiverAction || null,
        callQuality: analysis.callQuality || null,
      } : {
        sentiment: call.sentiment || null,
        mood: null,
        engagementScore: null,
        topics: [],
        concerns: call.concerns || [],
        positiveObservations: [],
        followUpSuggestions: [],
        caregiverTakeaways: [],
        recommendedCaregiverAction: null,
        callQuality: null,
      },
    });
  } catch (error) {
    routeError(res, error, 'GET /api/observability/calls/:id/observer');
  }
});

// Get call metrics (token usage, latency, cost)
router.get('/api/observability/calls/:id/metrics', requireAdmin, async (req, res) => {
  try {
    const [call] = await db.select({
      callSid: conversations.callSid,
      transcript: conversations.transcript,
      transcriptEncrypted: conversations.transcriptEncrypted,
      callMetrics: conversations.callMetrics,
      durationSeconds: conversations.durationSeconds,
    })
    .from(conversations)
    .where(eq(conversations.id, req.params.id));

    if (!call) {
      return res.status(404).json({ error: 'Call not found' });
    }

    const infraMetric = await fetchLatestInfraMetric(call.callSid);

    // Extract per-turn metrics from transcript
    const turnMetrics = [];
    const transcript = readTranscript(call);
    if (Array.isArray(transcript)) {
      transcript.forEach((turn, index) => {
        if (turn.metrics) {
          turnMetrics.push({
            turnIndex: index,
            role: turn.role,
            ...turn.metrics,
          });
        }
      });
    }

    const tokenUsage = infraMetric?.token_usage || {};
    const latency = infraMetric?.latency || {};
    const infraCallMetrics = infraMetric ? {
      durationSeconds: Number(infraMetric.duration_seconds || call.durationSeconds || 0),
      totalInputTokens: Number(tokenUsage.prompt_tokens || 0),
      totalOutputTokens: Number(tokenUsage.completion_tokens || 0),
      totalTokens: Number(tokenUsage.prompt_tokens || 0) + Number(tokenUsage.completion_tokens || 0),
      avgResponseTime: latency.turn_avg_ms != null ? Number(latency.turn_avg_ms) : null,
      avgTtfa: latency.tts_ttfb_avg_ms != null ? Number(latency.tts_ttfb_avg_ms) : null,
      turnCount: Number(infraMetric.turn_count || 0),
      estimatedCost: null,
      modelsUsed: [],
      llmTtfbAvgMs: latency.llm_ttfb_avg_ms != null ? Number(latency.llm_ttfb_avg_ms) : null,
      ttsTtfbAvgMs: latency.tts_ttfb_avg_ms != null ? Number(latency.tts_ttfb_avg_ms) : null,
      endReason: infraMetric.end_reason || null,
      errorCount: Number(infraMetric.error_count || 0),
      toolsUsed: infraMetric.tools_used || [],
      breakerStates: infraMetric.breaker_states || null,
    } : null;

    auditObservabilityRead(req, req.params.id, {
      endpoint: 'call_metrics',
      metricTurnCount: turnMetrics.length,
    });
    res.json({
      turnMetrics,
      callMetrics: infraCallMetrics || call.callMetrics || null,
      infraMetric: infraMetric ? { ...infraMetric, context_trace_encrypted: undefined } : null,
      durationSeconds: call.durationSeconds,
    });
  } catch (error) {
    routeError(res, error, 'GET /api/observability/calls/:id/metrics');
  }
});

// Get LLM context provenance for a call.
router.get('/api/observability/calls/:id/context', requireAdmin, async (req, res) => {
  try {
    const [call] = await db.select({
      id: conversations.id,
      callSid: conversations.callSid,
      durationSeconds: conversations.durationSeconds,
      status: conversations.status,
    })
    .from(conversations)
    .where(eq(conversations.id, req.params.id));

    if (!call) {
      return res.status(404).json({ error: 'Call not found' });
    }

    const infraMetric = await fetchLatestInfraMetric(call.callSid);
    const contextTrace = readContextTrace(infraMetric);
    const latency = readLatency(infraMetric);
    const toolsUsed = infraMetric?.tools_used || [];
    const hasLatencyBreakdown = Object.keys(contextTrace?.latency_breakdown || {}).length > 0;

    auditObservabilityRead(req, req.params.id, {
      endpoint: 'call_context',
      contextEventCount: contextTrace?.events?.length || 0,
    });

    res.json({
      callId: call.id,
      callSid: call.callSid,
      status: call.status,
      durationSeconds: call.durationSeconds,
      contextTrace: contextTrace || { version: 1, event_count: 0, latency_breakdown: {}, events: [] },
      latency,
      toolsUsed,
      captured: Boolean((contextTrace?.events?.length || 0) || hasLatencyBreakdown),
      schemaReady: Boolean(infraMetric && Object.prototype.hasOwnProperty.call(infraMetric, 'context_trace_encrypted')),
    });
  } catch (error) {
    routeError(res, error, 'GET /api/observability/calls/:id/context');
  }
});

// -------------------------------------------------------------------------
// Infrastructure Metrics (from call_metrics table)
// -------------------------------------------------------------------------

// Get recent call metrics for the infrastructure dashboard
router.get('/api/observability/metrics/calls', requireAdmin, async (req, res) => {
  try {
    const hours = Math.min(Math.max(parseInt(req.query.hours) || 24, 1), 168);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 500);

    const rows = await db.execute(sql`
      SELECT call_sid, senior_id, call_type, duration_seconds,
             end_reason, turn_count, phase_durations, latency,
             breaker_states, tools_used, token_usage, error_count,
             created_at
      FROM call_metrics
      WHERE created_at >= NOW() - ${hours + ' hours'}::interval
      ORDER BY created_at DESC
      LIMIT ${limit}
    `);

    res.json({ metrics: rows.rows, hours });
  } catch (error) {
    routeError(res, error, 'GET /api/observability/metrics/calls');
  }
});

// Get aggregated metrics summary for dashboard widgets
router.get('/api/observability/metrics/summary', requireAdmin, async (req, res) => {
  try {
    const hours = Math.min(Math.max(parseInt(req.query.hours) || 24, 1), 168);

    const summaryResult = await db.execute(sql`
      SELECT
        COUNT(*) AS total_calls,
        COUNT(*) FILTER (WHERE error_count = 0) AS successful_calls,
        ROUND(AVG(duration_seconds)) AS avg_duration_seconds,
        ROUND(AVG(turn_count)) AS avg_turn_count,
        ROUND(AVG((latency->>'llm_ttfb_avg_ms')::numeric)) AS avg_llm_ttfb_ms,
        ROUND(AVG((latency->>'tts_ttfb_avg_ms')::numeric)) AS avg_tts_ttfb_ms,
        ROUND(AVG((latency->>'turn_avg_ms')::numeric)) AS avg_turn_latency_ms
      FROM call_metrics
      WHERE created_at >= NOW() - ${hours + ' hours'}::interval
    `);

    const endReasons = await db.execute(sql`
      SELECT end_reason, COUNT(*)::int AS count
      FROM call_metrics
      WHERE created_at >= NOW() - ${hours + ' hours'}::interval
      GROUP BY end_reason
      ORDER BY count DESC
    `);

    res.json({
      summary: summaryResult.rows[0] || {},
      end_reasons: endReasons.rows,
      hours,
    });
  } catch (error) {
    routeError(res, error, 'GET /api/observability/metrics/summary');
  }
});

// Get latency trends (hourly averages for charts)
router.get('/api/observability/metrics/latency', requireAdmin, async (req, res) => {
  try {
    const hours = Math.min(Math.max(parseInt(req.query.hours) || 24, 1), 168);

    const rows = await db.execute(sql`
      SELECT
        date_trunc('hour', created_at) AS hour,
        COUNT(*) AS call_count,
        ROUND(AVG((latency->>'llm_ttfb_avg_ms')::numeric)) AS llm_ttfb_ms,
        ROUND(AVG((latency->>'tts_ttfb_avg_ms')::numeric)) AS tts_ttfb_ms,
        ROUND(AVG((latency->>'turn_avg_ms')::numeric)) AS turn_latency_ms,
        ROUND(AVG(duration_seconds)) AS avg_duration
      FROM call_metrics
      WHERE created_at >= NOW() - ${hours + ' hours'}::interval
        AND latency IS NOT NULL
      GROUP BY date_trunc('hour', created_at)
      ORDER BY hour ASC
    `);

    res.json({ latency: rows.rows, hours });
  } catch (error) {
    routeError(res, error, 'GET /api/observability/metrics/latency');
  }
});

// PHI-safe database scaling snapshot: pool pressure, lock waits, table stats,
// and slow-query aggregates by queryid only.
router.get('/api/observability/db', requireAdmin, async (req, res) => {
  try {
    const snapshot = await getDatabaseScalingSnapshot();
    logAudit({
      userId: req.auth.userId,
      userRole: authToRole(req.auth),
      action: 'read',
      resourceType: 'database',
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      metadata: { surface: 'observability', endpoint: 'db_scaling' },
    });
    res.json(snapshot);
  } catch (error) {
    routeError(res, error, 'GET /api/observability/db');
  }
});

export default router;
