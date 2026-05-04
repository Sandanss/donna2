let pendingOnboardingSession = false;

export function markPendingOnboardingSession() {
  pendingOnboardingSession = true;
}

export function clearPendingOnboardingSession() {
  pendingOnboardingSession = false;
}

export function hasPendingOnboardingSession() {
  return pendingOnboardingSession;
}
