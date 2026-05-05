import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const WEBSITE_SRC_DIR = path.join(process.cwd(), 'apps', 'website', 'src');
const ONBOARDING_STORE = path.join(WEBSITE_SRC_DIR, 'onboarding', 'store.jsx');

const BLOCKED_API_HOST_PATTERNS = [
  'donna-api-production',
  'donna-api-production.up.railway.app',
  '.up.railway.app',
];

function listSourceFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(fullPath));
    } else if (/\.(tsx?|jsx?)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }

  return files;
}

describe('website security guardrails', () => {
  it('does not hardcode production API hosts in website source', () => {
    const violations = [];

    for (const file of listSourceFiles(WEBSITE_SRC_DIR)) {
      const source = fs.readFileSync(file, 'utf8');
      for (const pattern of BLOCKED_API_HOST_PATTERNS) {
        if (source.includes(pattern)) {
          violations.push(`${path.relative(process.cwd(), file)} contains ${pattern}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('does not persist onboarding drafts in localStorage', () => {
    const source = fs.readFileSync(ONBOARDING_STORE, 'utf8');

    expect(source).not.toContain('localStorage.setItem(STORAGE_KEY');
    expect(source).not.toContain('localStorage.getItem(STORAGE_KEY');
    expect(source).toContain('localStorage.removeItem(STORAGE_KEY');
  });
});
