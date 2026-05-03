import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const routePath = path.join(process.cwd(), 'routes', 'calls.js');

describe('call route security structure', () => {
  const source = fs.readFileSync(routePath, 'utf8');

  it('requires seniorId call initiation instead of client supplied phoneNumber', () => {
    expect(source).toContain('const { seniorId, contextNotes } = req.body');
    expect(source).toContain('seniorService.getById(seniorId)');
    expect(source).not.toContain('const { phoneNumber } = req.body');
    expect(source).not.toContain('seniorService.findByPhone(phoneNumber)');
  });

  it('authorizes senior access before initiating a Telnyx call', () => {
    const accessCheck = source.indexOf('canAccessSenior(req.auth, senior.id)');
    const telnyxCall = source.indexOf('initiateTelnyxOutboundCall({');

    expect(accessCheck).toBeGreaterThan(-1);
    expect(telnyxCall).toBeGreaterThan(-1);
    expect(accessCheck).toBeLessThan(telnyxCall);
    expect(source).not.toContain('twilioClient.calls.create');
  });

  it('validates the server-resolved senior phone before calling', () => {
    expect(source).toContain('const callPhone = formatPhoneForCall(senior.phone)');
    expect(source).toContain("return sendError(res, 400, { error: 'Senior phone is not callable' })");
  });
});
