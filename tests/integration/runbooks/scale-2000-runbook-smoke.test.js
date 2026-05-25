// Category H — runbook smoke tests for the scale-to-2000 program.
//
// Purpose: catch silent drift between operational runbooks, npm scripts,
// migration filenames on disk, and CI configuration BEFORE it bites during
// a 2 AM drill. These are pure-static text checks — no DB, no Redis, no
// network. They read files, parse regex, and assert invariants.
//
// Authoring rules:
//   * Do not touch production code, runbooks, or package.json.
//   * Prefer `it.fails` over skip when an audit has already flagged a gap
//     so the test surfaces as an expected-fail rather than a passing lie.

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

function readFile(relativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

function fileExists(relativePath) {
  try {
    return fs.statSync(path.join(REPO_ROOT, relativePath)).isFile();
  } catch {
    return false;
  }
}

function dirExists(relativePath) {
  try {
    return fs.statSync(path.join(REPO_ROOT, relativePath)).isDirectory();
  } catch {
    return false;
  }
}

const SCALE_RUNBOOKS = [
  'docs/operations/scale-2000-phase0-readiness.md',
  'docs/operations/scale-2000-phase1-migration-runbook.md',
  'docs/operations/scale-2000-phase5-live-ab-runbook.md',
  'docs/operations/scale-2000-phase7-canary-runbook.md',
  'docs/operations/scale-2000-phase8-capacity-runbook.md',
  'docs/operations/scale-2000-live-drills.md',
  'docs/plans/2026-05-18-scale-to-2000-users-technical-plan.md',
];

describe('scale-2000 runbook smoke', () => {
  describe('runbook ↔ npm script mapping', () => {
    it('every phase{0..8}:* command referenced in runbooks maps to a defined npm script', () => {
      const packageJson = JSON.parse(readFile('package.json'));
      const scripts = packageJson.scripts || {};
      const phaseCommandPattern = /npm run (phase[0-9]+:[a-z0-9-]+)/g;

      const referenced = new Map(); // scriptName -> [{ file, line }]

      for (const rel of SCALE_RUNBOOKS) {
        if (!fileExists(rel)) {
          throw new Error(
            `Expected runbook not found: ${rel}. Either the file was renamed or this test list is stale.`
          );
        }
        const text = readFile(rel);
        const lines = text.split('\n');
        lines.forEach((line, idx) => {
          let match;
          const localPattern = /npm run (phase[0-9]+:[a-z0-9-]+)/g;
          while ((match = localPattern.exec(line)) !== null) {
            const script = match[1];
            if (!referenced.has(script)) referenced.set(script, []);
            referenced.get(script).push({ file: rel, line: idx + 1 });
          }
        });
        // Touch the global pattern to keep the lint happy for the file-level pass.
        phaseCommandPattern.lastIndex = 0;
      }

      // Sanity: the runbooks must reference at least one phase script.
      // If this drops to zero, either the runbooks got reorganised or our
      // regex stopped matching — either way, fail loud.
      expect(referenced.size, 'no phase scripts found in runbooks — pattern or runbook list is stale').toBeGreaterThan(0);

      const missing = [];
      for (const [script, locations] of referenced) {
        if (!(script in scripts)) {
          missing.push({ script, locations });
        }
      }

      if (missing.length > 0) {
        const detail = missing
          .map(({ script, locations }) => {
            const where = locations.map((l) => `${l.file}:${l.line}`).join(', ');
            return `  - "${script}" referenced at ${where} but not defined in package.json scripts`;
          })
          .join('\n');
        throw new Error(`Runbook references npm scripts that do not exist:\n${detail}`);
      }
    });
  });

  describe('concurrent_index migration safety', () => {
    const CONCURRENT_INDEX_FILES = [
      'db/migrations/011_call_queue_concurrent_indexes.sql',
      'pipecat/db/migrations/024_call_queue_concurrent_indexes.sql',
    ];

    // CREATE INDEX CONCURRENTLY (and unique variant) cannot run inside a
    // transaction. The migration runner must execute these files in
    // autocommit mode. We assert defensively that the file contains ONLY
    // concurrent index DDL and nothing else that would either (a) require
    // a transaction or (b) silently downgrade to a blocking index.
    const FORBIDDEN_PATTERNS = [
      { name: 'BEGIN', regex: /^\s*BEGIN\b/im },
      { name: 'COMMIT', regex: /^\s*COMMIT\b/im },
      { name: 'START TRANSACTION', regex: /\bSTART\s+TRANSACTION\b/i },
      { name: 'CREATE TABLE', regex: /\bCREATE\s+TABLE\b/i },
      { name: 'ALTER TABLE', regex: /\bALTER\s+TABLE\b/i },
      { name: 'DROP TABLE', regex: /\bDROP\s+TABLE\b/i },
      { name: 'CREATE TYPE', regex: /\bCREATE\s+TYPE\b/i },
      { name: 'CREATE FUNCTION', regex: /\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\b/i },
      { name: 'CREATE TRIGGER', regex: /\bCREATE\s+TRIGGER\b/i },
      { name: 'TRUNCATE', regex: /\bTRUNCATE\b/i },
      // A plain CREATE INDEX (without CONCURRENTLY) inside this file would
      // grab an ACCESS EXCLUSIVE lock — exactly what these files are
      // supposed to avoid.
      { name: 'non-concurrent CREATE INDEX', regex: /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b(?!\s+CONCURRENTLY)/i },
    ];

    function stripComments(sql) {
      // Remove -- line comments and /* */ block comments before scanning.
      return sql
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map((line) => line.replace(/--.*$/, ''))
        .join('\n');
    }

    for (const rel of CONCURRENT_INDEX_FILES) {
      it(`${rel} contains ONLY concurrent indexes and no transaction blocks or other DDL`, () => {
        const raw = readFile(rel);
        const sql = stripComments(raw);

        expect(
          /CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY/i.test(sql),
          `${rel} must contain at least one CREATE INDEX CONCURRENTLY statement`
        ).toBe(true);

        const violations = [];
        for (const { name, regex } of FORBIDDEN_PATTERNS) {
          if (regex.test(sql)) {
            violations.push(name);
          }
        }

        expect(
          violations,
          `${rel} contains DDL that would break a non-transactional concurrent-index migration runner: ${violations.join(', ')}`
        ).toEqual([]);
      });
    }
  });

  describe('phase1 runbook references match migration filenames on disk', () => {
    it('every migration filename mentioned in the phase1 runbook exists under db/migrations/ or pipecat/db/migrations/', () => {
      const runbookRel = 'docs/operations/scale-2000-phase1-migration-runbook.md';
      const text = readFile(runbookRel);

      // Match anything that looks like an ordered SQL migration filename.
      const filenamePattern = /\b(\d{3,4}_[a-z0-9_]+\.sql)\b/g;
      const referenced = new Set();
      let match;
      while ((match = filenamePattern.exec(text)) !== null) {
        referenced.add(match[1]);
      }

      expect(
        referenced.size,
        'phase1 runbook references no migration filenames — runbook or pattern drifted'
      ).toBeGreaterThan(0);

      const missing = [];
      for (const filename of referenced) {
        const nodePath = `db/migrations/${filename}`;
        const pipecatPath = `pipecat/db/migrations/${filename}`;
        if (!fileExists(nodePath) && !fileExists(pipecatPath)) {
          missing.push(filename);
        }
      }

      expect(
        missing,
        `Phase 1 runbook references migrations that do not exist on disk: ${missing.join(', ')}. ` +
          `Check db/migrations/ and pipecat/db/migrations/ for renamed/numbered files.`
      ).toEqual([]);
    });
  });

  describe('phase5 caller-ID canary ramp', () => {
    // The Phase 5 plan calls for a 50 → 100 → 250 attempt ramp at each
    // checkpoint, comparing answer rate to the Phase 0 baseline.
    it(
      'runbook codifies the 50→100→250 ramp with "answer rate" within 200 chars of each checkpoint',
      () => {
        const runbook = readFile('docs/operations/scale-2000-phase5-live-ab-runbook.md');
        const checkpoints = ['50', '100', '250'];
        const NEIGHBOURHOOD = 200;

        const missing = [];
        for (const checkpoint of checkpoints) {
          // Find any standalone occurrence of the number (not embedded in a
          // larger integer like "2500" or "1500").
          const numberRegex = new RegExp(`(?<!\\d)${checkpoint}(?!\\d)`, 'g');
          let found = false;
          let m;
          while ((m = numberRegex.exec(runbook)) !== null) {
            const start = Math.max(0, m.index - NEIGHBOURHOOD);
            const end = Math.min(runbook.length, m.index + checkpoint.length + NEIGHBOURHOOD);
            const window = runbook.slice(start, end).toLowerCase();
            if (window.includes('answer rate')) {
              found = true;
              break;
            }
          }
          if (!found) missing.push(checkpoint);
        }

        expect(
          missing,
          `Phase 5 runbook is missing the canary ramp checkpoints: ${missing.join(', ')}. ` +
            `The 50→100→250 attempt ramp must appear in the runbook with "answer rate" within ${NEIGHBOURHOOD} chars of each checkpoint.`
        ).toEqual([]);
      }
    );
  });

  describe('phase5 rollback SLO target', () => {
    // The rollback drill records start/completion timestamps and must compare
    // elapsed time against an explicit maximum rollback SLO.
    it(
      'runbook defines a maximum rollback time and the report script validates --rollback-target-seconds',
      () => {
        const runbook = readFile('docs/operations/scale-2000-phase5-live-ab-runbook.md');
        const script = readFile('scripts/phase5-live-ab-report.js');

        const runbookHasTimeTarget =
          /\b\d{1,5}\s+seconds?\b/i.test(runbook) ||
          /\b\d{1,3}\s+minutes?\b/i.test(runbook) ||
          /maximum\s+rollback\s+time/i.test(runbook) ||
          /rollback\s+SLO/i.test(runbook);

        const scriptHasTargetArg =
          /--rollback-target-seconds/.test(script) ||
          /rollbackTargetSeconds/.test(script);

        const issues = [];
        if (!runbookHasTimeTarget) {
          issues.push('runbook does not specify a maximum rollback time (e.g. "300 seconds" / "5 minutes")');
        }
        if (!scriptHasTargetArg) {
          issues.push('scripts/phase5-live-ab-report.js does not accept --rollback-target-seconds');
        }

        expect(issues, `Phase 5 rollback SLO gap: ${issues.join('; ')}`).toEqual([]);
      }
    );
  });

  describe('phi-sentinel CI gate is not a no-op', () => {
    // The Phase 0 readiness audit observed that the CI workflow runs
    // `npm run phi:sentinel` but none of the default scan paths
    // (logs/, tmp/, test-results/, playwright-report/, coverage/, artifacts/)
    // are guaranteed to exist or be populated before the scan runs. If the
    // step always skips, the gate is a no-op and won't catch PHI leaks.
    //
    // This test reads .github/workflows/ci.yml, finds steps that invoke
    // `npm run phi:sentinel`, and asserts either:
    //   (a) at least one default scan path actually exists in the repo, OR
    //   (b) the workflow explicitly populates one of those paths in an
    //       earlier step of the same job (e.g. via `--out=tmp/...` or
    //       `tee logs/...`).
    it(
      'phi-sentinel CI gate scans at least one non-empty path',
      () => {
        const ciYml = readFile('.github/workflows/ci.yml');

        const DEFAULT_SCAN_PATHS = [
          'logs',
          'tmp',
          'test-results',
          'playwright-report',
          'coverage',
          'artifacts',
        ];

        // Step 1: confirm the workflow actually invokes phi:sentinel.
        expect(
          /npm run phi:sentinel/.test(ciYml),
          '.github/workflows/ci.yml no longer runs `npm run phi:sentinel` — gate removed?'
        ).toBe(true);

        // Step 2: check whether any default scan path exists on disk.
        const existingOnDisk = DEFAULT_SCAN_PATHS.filter(
          (p) => dirExists(p) || dirExists(`pipecat/${p}`)
        );

        // Step 3: check whether any CI step writes to one of those paths
        // before the phi:sentinel scan.
        const populatesScanPath = DEFAULT_SCAN_PATHS.some((p) => {
          const writePatterns = [
            new RegExp(`--out=${p}/`),
            new RegExp(`--output-dir[= ]+${p}`),
            new RegExp(`>\\s*${p}/`),
            new RegExp(`tee\\s+${p}/`),
            new RegExp(`mkdir\\s+-p\\s+${p}`),
          ];
          return writePatterns.some((re) => re.test(ciYml));
        });

        // Step 4: check whether the workflow passes explicit `--paths=` to
        // phi:sentinel pointing at real source directories. This is the
        // cleanest fix because it makes the gate scan code/scripts every
        // run regardless of whether build artifacts happen to populate the
        // default paths.
        const pathsOverridePattern = /phi:sentinel[^\n]*--paths=([\w\/,.-]+)/g;
        const pathOverrides = [];
        let match;
        while ((match = pathsOverridePattern.exec(ciYml)) !== null) {
          for (const candidate of match[1].split(',')) {
            const cleaned = candidate.trim();
            if (cleaned) pathOverrides.push(cleaned);
          }
        }
        const overrideExistsOnDisk = pathOverrides.some((p) => dirExists(p));

        if (!overrideExistsOnDisk && existingOnDisk.length === 0 && !populatesScanPath) {
          throw new Error(
            'phi-sentinel CI gate may be a no-op. ' +
              `None of [${DEFAULT_SCAN_PATHS.join(', ')}] exist in the repo, no CI step ` +
              'populates any of them before `npm run phi:sentinel`, and the workflow does ' +
              'not pass `--paths=<existing-source-dir>` to override the defaults.'
          );
        }
      }
    );
  });
});
