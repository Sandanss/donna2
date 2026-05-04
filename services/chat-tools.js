/**
 * Chat Tools Service
 *
 * Defines the 5 Claude tools for the chat assistant and their execution handlers.
 * Tools only PROPOSE actions — they never write to the database directly.
 */

import { db } from '../db/client.js';
import { seniors, reminders } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { search as webSearch } from './web-search.js';

/**
 * Tool definitions for Claude (Anthropic tool_use format)
 */
export const toolDefinitions = [
  {
    name: 'get_current_schedule',
    description: "Retrieve the senior's current call schedule and active reminders. Use this to understand what's already scheduled before proposing new items.",
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'web_search',
    description: 'Search the web for information needed to schedule calls. Use this for sports schedules, event times, show schedules, etc.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query (e.g., "Houston Astros home game schedule May 2026")',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'propose_schedule_items',
    description: 'Propose new call schedule items for the caregiver to confirm. Do NOT use this to save — the caregiver must confirm first.',
    input_schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: 'Array of schedule items to propose',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Brief label for this call (e.g., "Pre-game call")' },
              frequency: { type: 'string', enum: ['one-time', 'daily', 'weekly'], description: 'How often this call recurs' },
              time: { type: 'string', description: 'Time in HH:MM format (24h)' },
              date: { type: 'string', description: 'ISO date string for one-time calls (YYYY-MM-DD)' },
              recurringDays: {
                type: 'array',
                items: { type: 'string', enum: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] },
                description: 'Days of the week for recurring calls',
              },
              contextNotes: { type: 'string', description: 'Notes for Donna about what to discuss on this call' },
            },
            required: ['title', 'frequency', 'time'],
          },
        },
        explanation: {
          type: 'string',
          description: 'Brief explanation of what you are proposing and why',
        },
      },
      required: ['items', 'explanation'],
    },
  },
  {
    name: 'propose_reminders',
    description: 'Propose new reminders for the caregiver to confirm. Reminders are messages Donna delivers during calls.',
    input_schema: {
      type: 'object',
      properties: {
        reminders: {
          type: 'array',
          description: 'Array of reminders to propose',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Reminder title' },
              description: { type: 'string', description: 'What Donna should tell the senior' },
              scheduledTime: { type: 'string', description: 'ISO datetime for one-time, or HH:MM for recurring' },
              isRecurring: { type: 'boolean', description: 'Whether this reminder repeats' },
              recurringDays: {
                type: 'array',
                items: { type: 'string', enum: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] },
                description: 'Days for recurring reminders',
              },
            },
            required: ['title', 'description'],
          },
        },
        explanation: {
          type: 'string',
          description: 'Brief explanation of what you are proposing',
        },
      },
      required: ['reminders', 'explanation'],
    },
  },
  {
    name: 'propose_blended',
    description: 'Propose a combination of schedule items AND linked reminders (e.g., "call at 5pm to remind about dinner at 5:30"). Use this when calls and reminders are logically connected.',
    input_schema: {
      type: 'object',
      properties: {
        scheduleItems: {
          type: 'array',
          description: 'Call schedule items to propose',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              frequency: { type: 'string', enum: ['one-time', 'daily', 'weekly'] },
              time: { type: 'string', description: 'HH:MM format' },
              date: { type: 'string', description: 'YYYY-MM-DD for one-time' },
              recurringDays: {
                type: 'array',
                items: { type: 'string', enum: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] },
              },
              contextNotes: { type: 'string' },
            },
            required: ['title', 'frequency', 'time'],
          },
        },
        reminders: {
          type: 'array',
          description: 'Linked reminders to propose',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              description: { type: 'string' },
              scheduledTime: { type: 'string' },
              isRecurring: { type: 'boolean' },
              recurringDays: {
                type: 'array',
                items: { type: 'string', enum: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] },
              },
            },
            required: ['title', 'description'],
          },
        },
        linkages: {
          type: 'array',
          description: 'Which reminders link to which schedule items (by array index)',
          items: {
            type: 'object',
            properties: {
              scheduleIndex: { type: 'integer', description: 'Index in scheduleItems array' },
              reminderIndex: { type: 'integer', description: 'Index in reminders array' },
            },
            required: ['scheduleIndex', 'reminderIndex'],
          },
        },
        explanation: { type: 'string' },
      },
      required: ['scheduleItems', 'reminders', 'linkages', 'explanation'],
    },
  },
];

/**
 * Execute a tool call and return the result.
 *
 * @param {string} toolName - Name of the tool to execute
 * @param {Object} input - Tool input parameters
 * @param {Object} context - Execution context
 * @param {string} context.seniorId - The senior's ID
 * @param {string} context.userId - The caregiver's Clerk user ID
 * @returns {Promise<Object>} Tool result
 */
export async function executeTool(toolName, input, context) {
  switch (toolName) {
    case 'get_current_schedule':
      return handleGetCurrentSchedule(context);
    case 'web_search':
      return handleWebSearch(input, context);
    case 'propose_schedule_items':
      return handleProposeScheduleItems(input);
    case 'propose_reminders':
      return handleProposeReminders(input);
    case 'propose_blended':
      return handleProposeBlended(input);
    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

async function handleGetCurrentSchedule({ seniorId }) {
  const [senior] = await db.select({
    preferredCallTimes: seniors.preferredCallTimes,
  }).from(seniors).where(eq(seniors.id, seniorId)).limit(1);

  const schedule = senior?.preferredCallTimes?.schedule || [];

  const activeReminders = await db.select({
    id: reminders.id,
    title: reminders.title,
    description: reminders.description,
    scheduledTime: reminders.scheduledTime,
    isRecurring: reminders.isRecurring,
    recurringDays: reminders.recurringDays,
  }).from(reminders).where(
    and(eq(reminders.seniorId, seniorId), eq(reminders.isActive, true))
  );

  return {
    schedule,
    reminders: activeReminders,
    summary: `${schedule.length} scheduled calls, ${activeReminders.length} active reminders`,
  };
}

async function handleWebSearch(input, context) {
  const results = await webSearch(input.query, { userId: context.userId });
  return results;
}

function handleProposeScheduleItems(input) {
  return {
    type: 'schedule_proposal',
    items: input.items,
    explanation: input.explanation,
    count: input.items.length,
  };
}

function handleProposeReminders(input) {
  return {
    type: 'reminder_proposal',
    reminders: input.reminders,
    explanation: input.explanation,
    count: input.reminders.length,
  };
}

function handleProposeBlended(input) {
  return {
    type: 'blended_proposal',
    scheduleItems: input.scheduleItems,
    reminders: input.reminders,
    linkages: input.linkages,
    explanation: input.explanation,
    scheduleCount: input.scheduleItems.length,
    reminderCount: input.reminders.length,
  };
}
