import { getPipecatPublicUrl, parseServiceApiKeys } from '../lib/security-config.js';

function getPipecatServiceKey(env = process.env, serviceLabel = null) {
  const keys = parseServiceApiKeys(env);
  if (serviceLabel) {
    const labeledKey = keys.get(serviceLabel);
    if (!labeledKey) {
      throw new Error(`DONNA_API_KEYS is missing ${serviceLabel} service key`);
    }
    return labeledKey;
  }
  for (const label of ['pipecat', 'node', 'scheduler', 'legacy']) {
    const key = keys.get(label);
    if (key) return key;
  }
  for (const key of keys.values()) {
    if (key) return key;
  }
  return env.DONNA_API_KEY || '';
}

function resolvePipecatUrl(baseUrl, env = process.env) {
  return String(baseUrl || getPipecatPublicUrl(env) || '').replace(/\/+$/, '');
}

async function postPipecat(path, body, { baseUrl, env = process.env, serviceLabel = null } = {}) {
  const pipecatUrl = resolvePipecatUrl(baseUrl, env);
  const apiKey = getPipecatServiceKey(env, serviceLabel);
  if (!pipecatUrl) {
    throw new Error('PIPECAT_PUBLIC_URL is not configured');
  }
  if (!apiKey) {
    throw new Error('DONNA_API_KEYS is not configured for service calls');
  }

  const response = await fetch(`${pipecatUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify(body || {}),
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const detail = payload?.detail || payload?.error || `HTTP ${response.status}`;
    throw new Error(`Pipecat Telnyx request failed: ${detail}`);
  }

  return payload;
}

export async function initiateTelnyxOutboundCall({
  seniorId,
  callType = 'check-in',
  reminderId,
  reminderIds,
  scheduledFor,
  existingDeliveryId,
  prewarmedContext,
  contextNotes,
  queueId,
  reservationId,
  serviceLabel,
  baseUrl,
}) {
  return postPipecat('/telnyx/outbound', {
    seniorId,
    callType,
    ...(reminderId ? { reminderId } : {}),
    ...(reminderIds?.length ? { reminderIds } : {}),
    ...(scheduledFor ? { scheduledFor } : {}),
    ...(existingDeliveryId ? { existingDeliveryId } : {}),
    ...(prewarmedContext ? { prewarmedContext } : {}),
    ...(contextNotes ? { contextNotes } : {}),
    ...(queueId ? { queueId } : {}),
    ...(reservationId ? { reservationId } : {}),
  }, { baseUrl, serviceLabel });
}

export async function prewarmTelnyxOutboundContext({
  seniorId,
  callType = 'reminder',
  reminderId,
  scheduledFor,
  baseUrl,
}) {
  return postPipecat('/telnyx/prewarm', {
    seniorId,
    callType,
    ...(reminderId ? { reminderId } : {}),
    ...(scheduledFor ? { scheduledFor } : {}),
  }, { baseUrl });
}

export async function endTelnyxCall(callSid, { baseUrl } = {}) {
  return postPipecat(`/telnyx/calls/${encodeURIComponent(callSid)}/end`, {}, { baseUrl });
}
