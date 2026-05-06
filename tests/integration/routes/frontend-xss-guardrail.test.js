import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const ACTIVE_FRONTEND_DIRS = [
  path.join(process.cwd(), 'apps', 'admin-v2', 'src'),
  path.join(process.cwd(), 'apps', 'website', 'src'),
  path.join(process.cwd(), 'apps', 'observability', 'src'),
];

const BLOCKED_PATTERNS = [
  'dangerouslySetInnerHTML',
  '.innerHTML',
  '.outerHTML',
  'insertAdjacentHTML',
  'DOMParser',
  'marked(',
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

describe('active frontend XSS guardrail', () => {
  it('does not introduce raw HTML rendering sinks', () => {
    const violations = [];
    const files = ACTIVE_FRONTEND_DIRS.flatMap(listSourceFiles);

    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      for (const pattern of BLOCKED_PATTERNS) {
        if (source.includes(pattern)) {
          violations.push(`${path.relative(process.cwd(), file)} contains ${pattern}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
