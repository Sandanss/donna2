-- Capture Telnyx AMD classification + Quick Observer goodbye timing on the
-- conversation row. Lets post-call analytics correlate misclassification
-- (e.g. AMD says 'silence' but it was actually voicemail) and the
-- programmatic-goodbye cutoff regressions we saw 2026-05-25.
--
-- Both columns are nullable: AMD may be disabled, and not every call sees
-- a strong goodbye signal.

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS amd_result VARCHAR(40),
  ADD COLUMN IF NOT EXISTS goodbye_detected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS end_reason VARCHAR(60);

COMMENT ON COLUMN conversations.amd_result
  IS 'Telnyx AMD classification: human, human_residence, human_business, machine, beep_detected, silence, not_sure, fax_detected, etc. NULL if AMD was disabled or did not resolve.';
COMMENT ON COLUMN conversations.goodbye_detected_at
  IS 'Timestamp when Quick Observer first detected a STRONG goodbye signal during this call. NULL if no strong goodbye was matched.';
COMMENT ON COLUMN conversations.end_reason
  IS 'How the call ended: user_hangup, goodbye_detected, goodbye_detected_qo_transition, goodbye_detected_safety_net, time_limit, error.';
