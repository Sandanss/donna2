import { db } from '../db/client.js';
import { callAnalyses, conversations, reminderDeliveries, reminders, seniors } from '../db/schema.js';
import { eq, and, gte, lte, sql } from 'drizzle-orm';
import { createLogger } from '../lib/logger.js';
import { normalizeCallAnalysis } from './call-analyses.js';

const log = createLogger('WeeklyReport');

export const weeklyReportService = {
  /**
   * Build a structured weekly report for a senior.
   */
  async buildReport(seniorId, startDate, endDate) {
    // 1. Get senior name
    const [senior] = await db.select({ name: seniors.name })
      .from(seniors)
      .where(eq(seniors.id, seniorId))
      .limit(1);

    const seniorName = senior?.name || 'Your loved one';

    // 2. Query call analyses for the week
    const analysisRows = await db.select()
      .from(callAnalyses)
      .where(and(
        eq(callAnalyses.seniorId, seniorId),
        gte(callAnalyses.createdAt, startDate),
        lte(callAnalyses.createdAt, endDate),
      ));
    const analyses = analysisRows.map(normalizeCallAnalysis).filter(Boolean);

    // 3. Query conversations for call count + total duration
    const calls = await db.select({
      count: sql`count(*)::int`,
      totalSeconds: sql`coalesce(sum(${conversations.durationSeconds}), 0)::int`,
    })
      .from(conversations)
      .where(and(
        eq(conversations.seniorId, seniorId),
        gte(conversations.createdAt, startDate),
        lte(conversations.createdAt, endDate),
        eq(conversations.status, 'completed'),
      ));

    const callCount = calls[0]?.count || 0;
    const totalMinutes = Math.round((calls[0]?.totalSeconds || 0) / 60);

    // 4. Query reminder deliveries for the week
    const deliveries = await db.select({
      status: reminderDeliveries.status,
      count: sql`count(*)::int`,
    })
      .from(reminderDeliveries)
      .innerJoin(reminders, eq(reminderDeliveries.reminderId, reminders.id))
      .where(and(
        eq(reminders.seniorId, seniorId),
        gte(reminderDeliveries.createdAt, startDate),
        lte(reminderDeliveries.createdAt, endDate),
      ))
      .groupBy(reminderDeliveries.status);

    const reminderStats = { delivered: 0, acknowledged: 0, missed: 0 };
    for (const d of deliveries) {
      if (d.status === 'delivered' || d.status === 'retry_pending') {
        reminderStats.delivered += d.count;
      } else if (d.status === 'acknowledged' || d.status === 'confirmed') {
        reminderStats.acknowledged += d.count;
      } else if (d.status === 'max_attempts') {
        reminderStats.missed += d.count;
      }
    }

    // 5. Aggregate analysis data
    const allTopics = [];
    const allPositive = [];
    const allHighlights = [];
    const engagementScores = [];

    for (const a of analyses) {
      if (a.topics) allTopics.push(...a.topics);
      if (a.positiveObservations) allPositive.push(...a.positiveObservations);
      if (a.followUpSuggestions) allHighlights.push(...a.followUpSuggestions);
      if (a.engagementScore) engagementScores.push(a.engagementScore);
    }

    const avgEngagement = engagementScores.length > 0
      ? Math.round(engagementScores.reduce((a, b) => a + b, 0) / engagementScores.length * 10) / 10
      : null;

    // Deduplicate
    const topics = [...new Set(allTopics)];
    const positiveObservations = [...new Set(allPositive)];
    const highlights = [...new Set(allHighlights)];

    return {
      senior: { name: seniorName },
      period: {
        start: startDate.toISOString().split('T')[0],
        end: endDate.toISOString().split('T')[0],
      },
      calls: { count: callCount, totalMinutes, avgEngagement },
      topics,
      positiveObservations,
      reminders: reminderStats,
      engagementTrend: engagementScores,
      highlights,
    };
  },

  /**
   * Build an inline HTML email template for the weekly report.
   */
  buildEmailHTML(report) {
    const { senior, period, calls, topics, positiveObservations, reminders, engagementTrend, highlights } = report;

    // Engagement trend indicator
    let trendText = 'No data';
    if (engagementTrend.length >= 2) {
      const first = engagementTrend.slice(0, Math.ceil(engagementTrend.length / 2));
      const second = engagementTrend.slice(Math.ceil(engagementTrend.length / 2));
      const avgFirst = first.reduce((a, b) => a + b, 0) / first.length;
      const avgSecond = second.reduce((a, b) => a + b, 0) / second.length;
      if (avgSecond > avgFirst + 0.5) trendText = 'Improving';
      else if (avgSecond < avgFirst - 0.5) trendText = 'Declining';
      else trendText = 'Steady';
    } else if (engagementTrend.length === 1) {
      trendText = `${engagementTrend[0]}/10`;
    }

    const topicsList = topics.length > 0
      ? topics.map(t => `<li style="margin-bottom: 4px; color: #333;">${escapeHtml(t)}</li>`).join('')
      : '<li style="color: #999;">No topics recorded this week</li>';

    const positiveList = positiveObservations.length > 0
      ? positiveObservations.map(p => `<li style="margin-bottom: 4px; color: #333;">${escapeHtml(p)}</li>`).join('')
      : '';

    const highlightsList = highlights.length > 0
      ? highlights.map(h => `<li style="margin-bottom: 4px; color: #333;">${escapeHtml(h)}</li>`).join('')
      : '';

    return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin: 0; padding: 0; background: #f9fafb; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <div style="max-width: 600px; margin: 0 auto; padding: 20px;">

    <!-- Header -->
    <div style="background: #4A5D4F; color: white; padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">
      <h1 style="margin: 0; font-size: 24px; font-weight: 600;">Donna</h1>
      <p style="margin: 8px 0 0; opacity: 0.9; font-size: 14px;">Weekly Companion Report</p>
    </div>

    <div style="background: white; padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">

      <!-- Title -->
      <h2 style="margin: 0 0 4px; color: #1a1a1a; font-size: 20px;">This week with ${escapeHtml(senior.name)}</h2>
      <p style="margin: 0 0 24px; color: #888; font-size: 13px;">${escapeHtml(period.start)} to ${escapeHtml(period.end)}</p>

      <!-- Call Summary -->
      <div style="background: #f0fdf4; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
        <h3 style="margin: 0 0 12px; color: #4A5D4F; font-size: 14px; text-transform: uppercase; letter-spacing: 1px;">Call Summary</h3>
        <div style="display: flex; justify-content: space-around; text-align: center;">
          <div>
            <div style="font-size: 28px; font-weight: 700; color: #4A5D4F;">${calls.count}</div>
            <div style="font-size: 12px; color: #666;">Calls</div>
          </div>
          <div>
            <div style="font-size: 28px; font-weight: 700; color: #4A5D4F;">${calls.totalMinutes}</div>
            <div style="font-size: 12px; color: #666;">Minutes</div>
          </div>
          <div>
            <div style="font-size: 28px; font-weight: 700; color: #4A5D4F;">${calls.avgEngagement ?? '-'}</div>
            <div style="font-size: 12px; color: #666;">Engagement</div>
          </div>
        </div>
        <div style="text-align: center; margin-top: 8px; font-size: 13px; color: #666;">
          Engagement trend: <strong>${trendText}</strong>
        </div>
      </div>

      <!-- Topics -->
      <div style="margin-bottom: 24px;">
        <h3 style="margin: 0 0 8px; color: #1a1a1a; font-size: 15px;">Topics Discussed</h3>
        <ul style="margin: 0; padding-left: 20px; font-size: 14px;">${topicsList}</ul>
      </div>

      ${positiveObservations.length > 0 ? `
      <!-- Positive Observations -->
      <div style="margin-bottom: 24px; background: #f0fdf4; border-radius: 8px; padding: 16px;">
        <h3 style="margin: 0 0 8px; color: #166534; font-size: 15px;">Positive Observations</h3>
        <ul style="margin: 0; padding-left: 20px; font-size: 14px;">${positiveList}</ul>
      </div>
      ` : ''}

      <!-- Reminder Stats -->
      <div style="margin-bottom: 24px;">
        <h3 style="margin: 0 0 8px; color: #1a1a1a; font-size: 15px;">Reminders</h3>
        <div style="font-size: 14px; color: #555;">
          <span style="margin-right: 16px;">Delivered: <strong>${reminders.delivered}</strong></span>
          <span style="margin-right: 16px;">Acknowledged: <strong>${reminders.acknowledged}</strong></span>
          <span>Missed: <strong style="${reminders.missed > 0 ? 'color: #dc2626;' : ''}">${reminders.missed}</strong></span>
        </div>
      </div>

      ${highlights.length > 0 ? `
      <!-- Conversation Ideas -->
      <div style="margin-bottom: 24px;">
        <h3 style="margin: 0 0 8px; color: #1a1a1a; font-size: 15px;">Conversation Ideas for Next Week</h3>
        <ul style="margin: 0; padding-left: 20px; font-size: 14px;">${highlightsList}</ul>
      </div>
      ` : ''}

    </div>

    <!-- Footer -->
    <div style="text-align: center; padding: 16px; color: #999; font-size: 12px;">
      <p style="margin: 0;">Powered by <a href="https://consumer-ruddy.vercel.app" style="color: #4A5D4F; text-decoration: none;">Donna</a></p>
      <p style="margin: 4px 0 0;">Your AI companion for family connection</p>
    </div>

  </div>
</body>
</html>`;
  },
};

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
