/**
 * SIGTERM end-to-end shutdown test (Category D coverage backfill).
 *
 * Spawns `node index.js` as a real subprocess, waits for the HTTP server
 * to come up, then sends SIGTERM and asserts the process drains and exits
 * cleanly within NODE_DISPATCHER_DRAIN_TIMEOUT_MS + 5s.
 *
 * This exercises the full SIGTERM → shutdown() → drain → exit(0) path in
 * `index.js`, which is the production-side contract Railway depends on for
 * zero-downtime rolling restarts. The matching unit-test surface (call-queue
 * drain helpers, the `shutdown` function itself) is covered elsewhere; this
 * test exists to ensure the wiring between them survives in a real process.
 */

import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..', '..');
const INDEX_JS = path.join(REPO_ROOT, 'index.js');

// Generous budget: drain timeout (default 30s) + 5s grace + spawn/listen latency.
// We override the drain timeout to 1s in env to keep the test fast.
const DRAIN_TIMEOUT_MS = 1000;
const TEST_TIMEOUT_MS = DRAIN_TIMEOUT_MS + 5000 + 10000;

function spawnDonnaNode() {
  const env = {
    // Inherit PATH and a few essentials so node can resolve.
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    // Force non-production so assertNodeSecurityConfig does not require
    // production-grade secrets / https URLs.
    NODE_ENV: 'test',
    ENVIRONMENT: 'development',
    // Bind to ephemeral port to avoid colliding with anything in CI.
    PORT: '0',
    // Pipecat URL points at a non-routable port so we never accidentally
    // dial out from a test process.
    PIPECAT_PUBLIC_URL: 'http://localhost:65535',
    // Required by the security layer in non-prod paths.
    JWT_SECRET: 'test-secret-sigterm-e2e',
    DONNA_API_KEYS: 'test:test',
    // Keep REDIS_URL empty so we stay in single-instance mode and don't
    // depend on shared state.
    REDIS_URL: '',
    // Don't start the reminder scheduler — it would try to talk to a DB.
    SCHEDULER_ENABLED: 'false',
    // Tight drain budget so the test is fast.
    NODE_DISPATCHER_DRAIN_TIMEOUT_MS: String(DRAIN_TIMEOUT_MS),
    // Disable Sentry — never want a test phoning home.
    SENTRY_DSN: '',
    // Make the DB layer fail fast if anything touches it during boot.
    DATABASE_URL: 'postgresql://invalid:invalid@127.0.0.1:65535/none',
  };

  return spawn(process.execPath, ['--disable-warning=DEP0040', INDEX_JS], {
    cwd: REPO_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function waitForListening(child, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(
        `Server did not log "listening on port" within ${timeoutMs}ms.\n` +
        `STDOUT:\n${stdout}\nSTDERR:\n${stderr}`
      ));
    }, timeoutMs);

    function onStdout(chunk) {
      stdout += chunk.toString();
      if (/listening on port/i.test(stdout)) {
        cleanup();
        resolve({ stdout, stderr });
      }
    }
    function onStderr(chunk) { stderr += chunk.toString(); }
    function onExit(code, signal) {
      cleanup();
      reject(new Error(
        `Process exited before listening (code=${code}, signal=${signal}).\n` +
        `STDOUT:\n${stdout}\nSTDERR:\n${stderr}`
      ));
    }
    function cleanup() {
      clearTimeout(timer);
      child.stdout?.off('data', onStdout);
      child.stderr?.off('data', onStderr);
      child.off('exit', onExit);
    }

    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.once('exit', onExit);
  });
}

function captureOutputUntilExit(child) {
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });

  const exited = new Promise(resolve => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });

  return { exited, get stdout() { return stdout; }, get stderr() { return stderr; } };
}

describe('SIGTERM end-to-end shutdown', () => {
  it('drains and exits 0 within NODE_DISPATCHER_DRAIN_TIMEOUT_MS + 5s when SIGTERM is received',
    async () => {
      const child = spawnDonnaNode();
      try {
        await waitForListening(child);
        const capture = captureOutputUntilExit(child);

        const sigtermAt = Date.now();
        // Use process.kill (the standard Node way) to send SIGTERM by pid,
        // exactly matching how Railway/Kubernetes terminate a pod.
        process.kill(child.pid, 'SIGTERM');

        const exitWatchdog = new Promise((_, reject) => {
          setTimeout(() => reject(new Error(
            `Process did not exit within ${TEST_TIMEOUT_MS}ms after SIGTERM`
          )), TEST_TIMEOUT_MS).unref();
        });

        const { code, signal } = await Promise.race([capture.exited, exitWatchdog]);
        const elapsed = Date.now() - sigtermAt;

        // (a) exits within drain timeout + 5s grace (we already raced against
        // a watchdog, but assert explicitly for a clear failure message).
        expect(elapsed).toBeLessThan(DRAIN_TIMEOUT_MS + 5000);
        // (b) exit code is 0 (clean drain).
        expect(code).toBe(0);
        expect(signal).toBeNull();
        // (c) stdout contains the shutdown-complete log line.
        expect(capture.stdout).toMatch(/Node graceful shutdown complete/);
      } finally {
        // Defensive: if the test failed before SIGTERM, make sure we don't
        // leak the subprocess into the suite.
        if (child.exitCode === null && child.signalCode === null) {
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
        }
      }
    },
    TEST_TIMEOUT_MS + 5000,
  );
});
