/**
 * Chat Route — SSE Streaming
 *
 * POST /api/chat
 * Streams Claude responses + tool proposals via Server-Sent Events.
 * Claude proposes schedule/reminder changes; the frontend confirms and saves.
 */

import { Router } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { requireAuth } from '../middleware/auth.js';
import { canAccessSenior, routeError } from './helpers.js';
import { db } from '../db/client.js';
import { seniors } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { toolDefinitions, executeTool } from '../services/chat-tools.js';
import { logAudit } from '../services/audit.js';
import { decryptSeniorPhi } from '../lib/phi.js';

const router = Router();

const anthropic = new Anthropic();

function buildSystemPrompt(senior, caregiverName) {
  const schedule = senior.preferredCallTimes?.schedule || [];
  const timezone = senior.preferredCallTimes?.timezone || 'America/Chicago';
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: timezone });

  return `You are Donna's scheduling assistant. You help ${caregiverName} manage calls and reminders for ${senior.name}.

Current schedule: ${schedule.length} items configured.
Senior's timezone: ${timezone}
Today's date: ${today}

Rules:
- Always confirm before saving. Use the propose_* tools to show what you'll create.
- For requests involving dates/times from the web (sports schedules, event times), use web_search first.
- For blended call+reminder requests (e.g., "call at 5pm to remind about dinner"), use propose_blended.
- Be concise. For bulk proposals (>10 items), show a summary count and representative examples.
- If the user's request is ambiguous, ask a clarifying question rather than guessing.
- When proposing schedule items, use 24-hour time format (HH:MM).
- For one-time calls, always include the date in YYYY-MM-DD format.
- For recurring calls, include recurringDays array with short day names (Mon, Tue, Wed, Thu, Fri, Sat, Sun).
- Use get_current_schedule if you need to check for conflicts with existing items.`;
}

router.post('/api/chat', requireAuth, async (req, res) => {
  try {
    const { messages, seniorId } = req.body;

    if (!messages || !Array.isArray(messages) || !seniorId) {
      return res.status(400).json({ error: 'messages (array) and seniorId are required' });
    }

    // Verify access
    const hasAccess = await canAccessSenior(req.auth, seniorId);
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied to this senior' });
    }

    // Load senior profile
    const [rawSenior] = await db.select().from(seniors).where(eq(seniors.id, seniorId)).limit(1);
    if (!rawSenior) {
      return res.status(404).json({ error: 'Senior not found' });
    }
    const senior = decryptSeniorPhi(rawSenior);

    const caregiverName = 'Caregiver';

    // Audit log
    logAudit({
      userId: req.auth.userId,
      userRole: 'caregiver',
      action: 'create',
      resourceType: 'chat',
      resourceId: seniorId,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    // Set up SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const sendEvent = (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Build messages for Claude (filter to role + content only)
    const claudeMessages = messages.map(m => ({
      role: m.role,
      content: m.content,
    }));

    const systemPrompt = buildSystemPrompt(senior, caregiverName);
    const context = { seniorId, userId: req.auth.userId };

    // Agentic loop: keep calling Claude until it stops using tools
    let currentMessages = [...claudeMessages];
    let loopCount = 0;
    const MAX_LOOPS = 10;

    while (loopCount < MAX_LOOPS) {
      loopCount++;

      const stream = anthropic.messages.stream({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: systemPrompt,
        tools: toolDefinitions,
        messages: currentMessages,
      });

      let hasToolUse = false;
      const toolUseBlocks = [];
      let currentToolUse = null;

      for await (const event of stream) {
        if (event.type === 'content_block_start') {
          if (event.content_block.type === 'text') {
            // Start of text block
          } else if (event.content_block.type === 'tool_use') {
            hasToolUse = true;
            currentToolUse = {
              id: event.content_block.id,
              name: event.content_block.name,
              input: '',
            };
            sendEvent('thinking', { message: getThinkingMessage(event.content_block.name) });
          }
        } else if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') {
            sendEvent('text', { text: event.delta.text });
          } else if (event.delta.type === 'input_json_delta') {
            if (currentToolUse) {
              currentToolUse.input += event.delta.partial_json;
            }
          }
        } else if (event.type === 'content_block_stop') {
          if (currentToolUse) {
            toolUseBlocks.push(currentToolUse);
            currentToolUse = null;
          }
        }
      }

      // If no tool use, we're done
      if (!hasToolUse) {
        break;
      }

      // Execute tool calls and build the continuation
      const assistantContent = [];
      const finalMessage = await stream.finalMessage();

      // Add all content blocks from the assistant response
      for (const block of finalMessage.content) {
        assistantContent.push(block);
      }

      currentMessages.push({ role: 'assistant', content: assistantContent });

      // Execute each tool and collect results
      const toolResults = [];
      for (const toolBlock of toolUseBlocks) {
        let input;
        try {
          input = typeof toolBlock.input === 'string' ? JSON.parse(toolBlock.input) : toolBlock.input;
        } catch {
          input = {};
        }

        const result = await executeTool(toolBlock.name, input, context);

        // If this is a proposal, send it to the frontend
        if (result.type && result.type.endsWith('_proposal')) {
          sendEvent('proposal', result);
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolBlock.id,
          content: JSON.stringify(result),
        });
      }

      currentMessages.push({ role: 'user', content: toolResults });
    }

    sendEvent('done', {});
    res.end();
  } catch (error) {
    // If headers already sent, try to send error event
    if (res.headersSent) {
      try {
        res.write(`event: error\ndata: ${JSON.stringify({ error: 'An error occurred' })}\n\n`);
        res.end();
      } catch {
        // Connection already closed
      }
    } else {
      routeError(res, error, 'POST /api/chat');
    }
  }
});

function getThinkingMessage(toolName) {
  switch (toolName) {
    case 'web_search': return 'Searching the web...';
    case 'get_current_schedule': return 'Checking current schedule...';
    case 'propose_schedule_items': return 'Preparing schedule proposal...';
    case 'propose_reminders': return 'Preparing reminder proposal...';
    case 'propose_blended': return 'Preparing your proposal...';
    default: return 'Working on it...';
  }
}

export default router;
