import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const chatRouteSource = fs.readFileSync(path.resolve('routes/chat.js'), 'utf8');
const chatToolsSource = fs.readFileSync(path.resolve('services/chat-tools.js'), 'utf8');

describe('chat assistant privacy guardrails', () => {
  it('decrypts senior PHI before building the chat system prompt', () => {
    expect(chatRouteSource).toContain("import { decryptSeniorPhi } from '../lib/phi.js'");
    expect(chatRouteSource).toContain('const senior = decryptSeniorPhi(rawSenior)');
    expect(chatRouteSource.indexOf('decryptSeniorPhi(rawSenior)')).toBeLessThan(
      chatRouteSource.indexOf('const systemPrompt = buildSystemPrompt(senior, caregiverName)')
    );
  });

  it('reads encrypted schedule and reminder fields for current schedule tool results', () => {
    expect(chatToolsSource).toContain("import { decryptReminderPhi, decryptSeniorPhi } from '../lib/phi.js'");
    expect(chatToolsSource).toContain('preferredCallTimesEncrypted: seniors.preferredCallTimesEncrypted');
    expect(chatToolsSource).toContain('titleEncrypted: reminders.titleEncrypted');
    expect(chatToolsSource).toContain('descriptionEncrypted: reminders.descriptionEncrypted');
    expect(chatToolsSource).toContain('activeReminders.map(decryptReminderPhi)');
  });
});
