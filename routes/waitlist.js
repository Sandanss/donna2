import { Router } from 'express';
import { db } from '../db/client.js';
import { waitlist } from '../db/schema.js';
import { routeError } from './helpers.js';
import { encryptWaitlistPhi } from '../lib/phi.js';
import { writeLimiter } from '../middleware/rate-limit.js';

const router = Router();

// Ensure table exists on first request
let tableReady = false;
async function ensureTable() {
  if (tableReady) return;
  await db.execute(`
    CREATE TABLE IF NOT EXISTS waitlist (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL,
      phone VARCHAR(50),
      who_for VARCHAR(100),
      thoughts TEXT,
      payload_encrypted TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await db.execute(`
    ALTER TABLE waitlist
      ADD COLUMN IF NOT EXISTS payload_encrypted TEXT
  `);
  tableReady = true;
}

// Basic email format check — intentionally simple to avoid rejecting valid addresses
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Field length limits
const MAX_NAME = 255;
const MAX_EMAIL = 255;
const MAX_PHONE = 50;
const MAX_WHO_FOR = 100;
const MAX_THOUGHTS = 2000;

// Public endpoint — no API key required (mounted outside /api prefix)
// Rate-limited to prevent spam/DoS.
router.post('/waitlist', writeLimiter, async (req, res) => {
  try {
    const { name, email, phone, whoFor, thoughts } = req.body;

    if (!name || !email) {
      return res.status(400).json({ error: 'Name and email are required' });
    }

    if (typeof name !== 'string' || typeof email !== 'string') {
      return res.status(400).json({ error: 'Invalid input' });
    }

    const trimmedEmail = String(email).trim();
    if (!EMAIL_RE.test(trimmedEmail)) {
      return res.status(400).json({ error: 'Please enter a valid email address' });
    }

    // Enforce field length limits
    if (name.length > MAX_NAME || trimmedEmail.length > MAX_EMAIL) {
      return res.status(400).json({ error: 'Input too long' });
    }
    if (phone && String(phone).length > MAX_PHONE) {
      return res.status(400).json({ error: 'Input too long' });
    }
    if (whoFor && String(whoFor).length > MAX_WHO_FOR) {
      return res.status(400).json({ error: 'Input too long' });
    }
    if (thoughts && String(thoughts).length > MAX_THOUGHTS) {
      return res.status(400).json({ error: 'Input too long' });
    }

    await ensureTable();
    await db.insert(waitlist).values(encryptWaitlistPhi({
      name: String(name).slice(0, MAX_NAME),
      email: trimmedEmail,
      phone: phone ? String(phone).slice(0, MAX_PHONE) : null,
      whoFor: whoFor ? String(whoFor).slice(0, MAX_WHO_FOR) : null,
      thoughts: thoughts ? String(thoughts).slice(0, MAX_THOUGHTS) : null,
    }));

    res.json({ success: true });
  } catch (error) {
    routeError(res, error, 'POST /waitlist');
  }
});

export default router;
