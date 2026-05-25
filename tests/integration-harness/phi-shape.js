/**
 * PHI shape traversal helpers for Category B (PHI shape) tests.
 *
 * The Phase 0/1/5 audits found that "PHI-free output" claims were validated
 * by `expect(JSON.stringify(report)).not.toMatch(/Jane|111-222/)` style
 * regex against fixture strings the mocks never returned. That approach
 * passes vacuously whenever the test fixture doesn't include those exact
 * strings, regardless of what the real code does with real PHI.
 *
 * The helpers in this file walk the actual output tree:
 *   - assertNoPhiShapeKeys: every key in the output must NOT match a
 *     PHI-shaped name (name, phone, transcript, etc).
 *   - assertNoPhiShapeValues: every string value in the output must NOT
 *     contain a known synthetic sentinel or a US phone shape.
 *   - assertNoPhiShape: convenience — runs both at once.
 *
 * Caller responsibility: feed the code under test rows / inputs that
 * include PHI-shaped values so that, if a code path forwards them, this
 * assertion catches it. A test that calls these helpers on output from
 * an empty fixture passes trivially — that's the anti-pattern these
 * helpers are designed to replace, so always combine with PHI-bearing
 * input fixtures.
 */

// PHI-shape keys: any field name we should never see in a PHI-safe surface.
// Intentionally broad — false positives on aggregate keys (e.g. `summary`
// in `report.summary`) are caught and resolved via an allowlist option.
export const PHI_KEY_REGEX = /name|phone|transcript|reminder|caregiver|note|prompt|content|summary/i;

// PHI-shape values: synthetic sentinels we plant in fixtures, plus the
// classic US phone pattern ("555-123-4567"), plus a few obvious PHI fixture
// strings used in the legacy regex assertions we're replacing.
export const PHI_VALUE_REGEX = /PHI_SENTINEL_|\d{3}-\d{3}-\d{4}|Jane Margaret|Dad's medication/;

/**
 * Synthetic PHI fixture values. Plant these in mocked DB rows / inputs;
 * if any code path forwards them to the output we walk afterward, the
 * traversal will fail loudly.
 */
export const PHI_SENTINELS = Object.freeze({
  name: 'PHI_SENTINEL_NAME_DO_NOT_LOG_Jane_Margaret',
  phone: '+1-555-867-5309', // matches PHI_VALUE_REGEX via the digits group
  transcript: 'PHI_SENTINEL_TRANSCRIPT_DO_NOT_LOG hi this is the senior speaking',
  reminderTitle: 'PHI_SENTINEL_REMINDER_DO_NOT_LOG take morning vitamins',
  reminderDescription: 'PHI_SENTINEL_NOTE_DO_NOT_LOG with breakfast and water',
  caregiverNote: 'PHI_SENTINEL_NOTE_DO_NOT_LOG daughter prefers afternoon calls',
  medicalNote: 'PHI_SENTINEL_MEDICAL_DO_NOT_LOG type 2 diabetes mild arthritis',
  summary: 'PHI_SENTINEL_TRANSCRIPT_DO_NOT_LOG she talked about her roses',
  content: 'PHI_SENTINEL_NOTE_DO_NOT_LOG plays bingo on Tuesdays',
  prompt: 'PHI_SENTINEL_NOTE_DO_NOT_LOG system prompt with senior name baked in',
  pii_phone_dashed: '555-867-5309',
});

function formatPath(path) {
  return path.length === 0 ? '<root>' : path.join('.');
}

/**
 * Recursively assert no key in `value` matches PHI_KEY_REGEX.
 *
 * @param {unknown} value         - the output to walk
 * @param {object}  [options]
 * @param {Set<string>} [options.allowedKeys]
 *   Exact keys we know are aggregate / structural and may semantically
 *   collide with PHI_KEY_REGEX. e.g. `summary` on a report root, `notes`
 *   field on a `phiPolicy` object.
 * @param {(path: string) => void} [options.fail] - thrown handler
 */
export function assertNoPhiShapeKeys(value, options = {}) {
  const allowedKeys = options.allowedKeys || new Set();
  const fail = options.fail || ((message) => {
    throw new Error(`PHI shape: ${message}`);
  });

  const seen = new WeakSet();

  function walk(node, path) {
    if (node === null || node === undefined) return;
    if (typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      node.forEach((item, idx) => walk(item, path.concat(`[${idx}]`)));
      return;
    }

    for (const [key, child] of Object.entries(node)) {
      if (!allowedKeys.has(key) && PHI_KEY_REGEX.test(key)) {
        fail(`disallowed PHI-shaped key "${key}" at ${formatPath(path)}`);
      }
      walk(child, path.concat(key));
    }
  }

  walk(value, []);
}

/**
 * Recursively assert no string value (or stringified bigint/number that
 * happens to match) in `value` contains a PHI sentinel or phone shape.
 *
 * @param {unknown} value
 * @param {object}  [options]
 * @param {RegExp}  [options.regex]        - override the default PHI_VALUE_REGEX
 * @param {string[]} [options.extraSentinels] - additional substrings to flag
 * @param {(message: string) => void} [options.fail]
 */
export function assertNoPhiShapeValues(value, options = {}) {
  const regex = options.regex || PHI_VALUE_REGEX;
  const extra = options.extraSentinels || [];
  const fail = options.fail || ((message) => {
    throw new Error(`PHI shape: ${message}`);
  });

  const seen = new WeakSet();

  function check(strValue, path) {
    if (regex.test(strValue)) {
      fail(`PHI-shaped value at ${formatPath(path)}: "${strValue.slice(0, 80)}"`);
    }
    for (const sentinel of extra) {
      if (sentinel && strValue.includes(sentinel)) {
        fail(`PHI sentinel "${sentinel}" leaked to ${formatPath(path)}`);
      }
    }
  }

  function walk(node, path) {
    if (node === null || node === undefined) return;
    if (typeof node === 'string') {
      check(node, path);
      return;
    }
    if (typeof node === 'number' || typeof node === 'bigint' || typeof node === 'boolean') {
      return;
    }
    if (typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      node.forEach((item, idx) => walk(item, path.concat(`[${idx}]`)));
      return;
    }

    for (const [key, child] of Object.entries(node)) {
      walk(child, path.concat(key));
    }
  }

  walk(value, []);
}

/**
 * Convenience — assert both no PHI keys and no PHI values.
 *
 * @param {unknown} value
 * @param {object}  [options] - merged into both helpers
 */
export function assertNoPhiShape(value, options = {}) {
  assertNoPhiShapeKeys(value, options);
  assertNoPhiShapeValues(value, options);
}
