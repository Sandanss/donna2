import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const serviceSource = fs.readFileSync(
  path.resolve('services/notifications.js'),
  'utf-8',
);

describe('services/notifications.js push integration', () => {
  it('imports the Expo server SDK', () => {
    expect(serviceSource).toMatch(
      /import\s+\{\s*Expo\s*\}\s+from\s+'expo-server-sdk'/,
    );
  });

  it('caregiver lookup includes the push token', () => {
    // _getCaregiversForSenior must select expoPushToken so onCallCompleted
    // can pass it through to _sendIfAllowed. Anchor on the definition,
    // not the call site.
    const fnStart = serviceSource.indexOf('async _getCaregiversForSenior(');
    expect(fnStart).toBeGreaterThan(-1);
    const fnSlice = serviceSource.slice(fnStart, fnStart + 500);
    expect(fnSlice).toContain('expoPushToken: caregivers.expoPushToken');
  });

  it('passes the push token through every event handler', () => {
    // call_completed, concern_detected, reminder_missed all need to
    // forward the token to _sendIfAllowed.
    const onCallCompleted = serviceSource.slice(
      serviceSource.indexOf('async onCallCompleted'),
      serviceSource.indexOf('async onConcernDetected'),
    );
    expect(onCallCompleted).toContain('expoPushToken: cg.expoPushToken');

    const onConcern = serviceSource.slice(
      serviceSource.indexOf('async onConcernDetected'),
      serviceSource.indexOf('async onReminderMissed'),
    );
    expect(onConcern).toContain('expoPushToken: cg.expoPushToken');

    const onReminderMissed = serviceSource.slice(
      serviceSource.indexOf('async onReminderMissed'),
      serviceSource.indexOf('// Internal helpers'),
    );
    expect(onReminderMissed).toContain('expoPushToken: cg.expoPushToken');
  });

  it('_sendIfAllowed only invokes _sendPush when a token is present', () => {
    const sendIfAllowed = serviceSource.slice(
      serviceSource.indexOf('async _sendIfAllowed'),
      serviceSource.indexOf('async _sendPush'),
    );
    expect(sendIfAllowed).toContain('if (opts.expoPushToken)');
    expect(sendIfAllowed).toContain('this._sendPush(');
  });

  it('_sendPush validates the token via Expo.isExpoPushToken', () => {
    const sendPush = serviceSource.slice(
      serviceSource.indexOf('async _sendPush'),
      serviceSource.indexOf('async _sendEmail'),
    );
    expect(sendPush).toContain('Expo.isExpoPushToken(pushToken)');
  });

  it('_sendPush includes type + seniorId in the data payload', () => {
    // Mobile listener uses data.type to invalidate the right query keys.
    const sendPush = serviceSource.slice(
      serviceSource.indexOf('async _sendPush'),
      serviceSource.indexOf('async _sendEmail'),
    );
    expect(sendPush).toContain('type: eventType');
    expect(sendPush).toContain('seniorId,');
  });

  it('clears the token when Expo reports DeviceNotRegistered', () => {
    const sendPush = serviceSource.slice(
      serviceSource.indexOf('async _sendPush'),
      serviceSource.indexOf('async _sendEmail'),
    );
    expect(sendPush).toContain("'DeviceNotRegistered'");
    expect(sendPush).toContain('expoPushToken: null');
  });
});
