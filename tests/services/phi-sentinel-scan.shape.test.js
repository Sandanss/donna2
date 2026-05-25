/**
 * Category B (PHI shape) test — phi-sentinel-scan script.
 *
 * The scanner exists to detect PHI sentinels in log/report artifacts. It
 * MUST NOT itself print the matched substring or surrounding line — that
 * would defeat the purpose. The audit found no end-to-end test verifying
 * the scanner's own output is PHI-shape-clean.
 *
 * This test runs the scanner as a real subprocess (so we exercise the
 * actual main() path and exit codes) and asserts:
 *   - findings name only the file path, sentinel label, and count
 *   - the matched content never appears in stdout or stderr
 *   - exit code 1 on findings, exit code 0 on a clean tree
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PHI_SENTINELS } from '../integration-harness/phi-shape.js';

const SCRIPT_PATH = path.resolve('scripts/phi-sentinel-scan.js');

function runScanner(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT_PATH, ...args], {
      cwd,
      env: { ...process.env, NODE_ENV: 'test' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

let tempDir;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'phi-sentinel-scan-test-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('phi-sentinel-scan output shape', () => {
  it('reports file path + sentinel label + count, never the matched line or surrounding content', async () => {
    // Plant a sentinel inside surrounding "real PHI-shaped" context so any
    // careless `console.log(line)` would leak. The surrounding context
    // contains a phone shape and a fake name that the scanner must NOT
    // echo back.
    const surroundingContext = [
      'PRE: senior name was Jane Margaret in this log line',
      `MATCH: ${PHI_SENTINELS.reminderTitle} should never echo`,
      `POST: caller phone 555-867-5309 also present`,
    ].join('\n');
    const targetFile = path.join(tempDir, 'donna.log');
    await fs.writeFile(targetFile, surroundingContext);

    const result = await runScanner(
      [`--paths=${tempDir}`, '--json'],
      // Run from the test's tempdir so absolute paths in the script's
      // DEFAULT_SCAN_PATHS that happen to exist in cwd don't interfere.
      tempDir,
    );

    // Non-zero exit because we DO have findings.
    expect(result.code, `expected nonzero exit, stdout=${result.stdout}, stderr=${result.stderr}`)
      .toBe(1);

    // JSON output should be on stdout.
    let summary;
    try {
      summary = JSON.parse(result.stdout);
    } catch (err) {
      throw new Error(`scanner did not emit JSON on stdout. stdout=${result.stdout}`);
    }

    expect(summary.ok).toBe(false);
    expect(Array.isArray(summary.findings)).toBe(true);
    expect(summary.findings.length).toBeGreaterThan(0);

    // Each finding has only the safe shape: file, sentinel, count.
    for (const finding of summary.findings) {
      expect(Object.keys(finding).sort()).toEqual(['count', 'file', 'sentinel']);
      // sentinel must be the LABEL (e.g. "PHI_SENTINEL_REMINDER_DO_NOT_LOG"),
      // never the surrounding line.
      expect(finding.sentinel).not.toContain('should never echo');
      expect(finding.sentinel).not.toContain('MATCH:');
      // count is a positive number.
      expect(finding.count).toBeGreaterThan(0);
    }

    // Hardest assertion: the surrounding line and the PHI shapes near the
    // sentinel must NEVER appear anywhere in stdout or stderr.
    const combined = `${result.stdout}\n${result.stderr}`;
    expect(combined).not.toContain('Jane Margaret');
    expect(combined).not.toContain('should never echo');
    expect(combined).not.toContain('555-867-5309');
    expect(combined).not.toContain('PRE: senior');
    expect(combined).not.toContain('POST: caller');
  });

  it('exits zero with no findings on a clean tree', async () => {
    // Empty tempdir — nothing to match.
    const result = await runScanner([`--paths=${tempDir}`, '--json'], tempDir);

    expect(result.code).toBe(0);
    const summary = JSON.parse(result.stdout);
    expect(summary.ok).toBe(true);
    expect(summary.findings).toEqual([]);
    expect(summary.filesScanned).toBe(0);
  });

  it('human-format output also names the sentinel label only, not the matched substring', async () => {
    const targetFile = path.join(tempDir, 'rendered.html');
    await fs.writeFile(
      targetFile,
      `<div>${PHI_SENTINELS.transcript}</div><span>Jane Margaret 555-867-5309</span>`,
    );

    // Without --json the script prints the human format to stderr.
    const result = await runScanner([`--paths=${tempDir}`], tempDir);

    expect(result.code).toBe(1);

    const combined = `${result.stdout}\n${result.stderr}`;
    // The label appears (so operators can investigate)...
    expect(combined).toContain('PHI_SENTINEL_TRANSCRIPT_DO_NOT_LOG');
    // ...but the surrounding/matched text does NOT.
    expect(combined).not.toContain('Jane Margaret');
    expect(combined).not.toContain('555-867-5309');
    expect(combined).not.toContain('hi this is the senior speaking');
    // And the matched-content disclaimer is present.
    expect(combined).toContain('Matched content is not printed');
  });
});
