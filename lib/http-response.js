import { createLogger } from './logger.js';

const log = createLogger('HTTP');

export function getRequestId(reqOrRes) {
  return reqOrRes?.id || reqOrRes?.req?.id || undefined;
}

export function withRequestId(reqOrRes, body = {}) {
  const requestId = getRequestId(reqOrRes);
  return requestId ? { ...body, requestId } : body;
}

export function sendError(res, status, body = {}) {
  return res.status(status).json(withRequestId(res, body));
}

export function logRouteError(context, error, reqOrRes, status = 500) {
  log.error(`${context} failed`, {
    requestId: getRequestId(reqOrRes),
    status,
    errorName: error?.name,
    errorCode: error?.code,
    errorMessage: error?.message,
    stack: error?.stack,
  });
}
