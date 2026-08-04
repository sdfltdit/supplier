import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import rateLimit from 'express-rate-limit';
import { db, initSchema } from './db.js';
import { sendSupplierConfirmation, sendInternalNotification } from './email.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
// Cap request body size — this form has no legitimate reason to need a
// large payload (no file upload wired up yet), so a small limit blocks
// oversized-payload abuse cheaply at the parsing layer.
app.use(express.json({ limit: '50kb' }));

// Render sits behind exactly one reverse proxy layer in front of this app.
// Setting this to the specific number of hops (not `true`) is important:
// `true` trusts the entire X-Forwarded-For header, including the leftmost
// entry, which a client can set to anything — that would let an attacker
// spoof a different IP on every request and bypass IP-based rate limiting
// entirely. `1` trusts only the value Render's own proxy actually adds.
app.set('trust proxy', 1);

// ─────────────────────────────────────────────────────────────
// Serve the supplier registration form itself from this same backend/
// domain. Doing this (rather than hosting the form on a different
// domain that calls this API) avoids CORS and CSP cross-origin issues
// entirely, since the page and the API it calls share an origin.
// ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '..', 'public')));

// ─────────────────────────────────────────────────────────────
// CORS: only allow the actual supplier-facing site to call this API.
// [VERIFY] Update ALLOWED_ORIGIN to whatever domain the form actually
// lives on (e.g. https://supplier.sdfltd.com or https://sdfltd.com).
// ─────────────────────────────────────────────────────────────
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://supplier.sdfltd.com';
app.use(cors({ origin: ALLOWED_ORIGIN }));

// ─────────────────────────────────────────────────────────────
// Rate limiting.
//
// Submission endpoint: a real supplier has no reason to submit this form
// repeatedly in a short window. 5 submissions per IP per hour is generous
// for a legitimate one-off registration while making scripted spam/abuse
// meaningfully slower and easier to notice in logs.
//
// Admin endpoint: this is protected by ADMIN_API_KEY, but without a rate
// limit, that key is brute-forceable by an attacker trying many values
// quickly. Limiting attempts per IP makes brute-forcing impractical
// without adding friction for the one legitimate caller (SDF staff).
// ─────────────────────────────────────────────────────────────
const submitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, errors: ['Too many submissions from this connection. Please try again later, or contact us directly.'] },
});

const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, errors: ['Too many requests. Please try again later.'] },
});

const REQUIRED_FIELDS = [
  'company_name', 'supplies', 'country', 'full_address',
  'mobile', 'whatsapp', 'email', 'sample_delivery_time', 'payment_mode',
];

const VALID_PAYMENT_MODES = ['LC', 'TT', 'Cash', 'Others'];
const VALID_SUPPLIES = ['Fabric', 'Yarn', 'Trims', 'Chemical', 'Print', 'Embroidery', 'Wash / Stone', 'Packaging', 'Others'];

// Reasonable upper bounds per field — none of these need to be huge, and
// capping them blocks a class of abuse (giant payloads meant to bloat the
// database or slow down processing) that basic required-field checks alone
// don't catch.
const MAX_LENGTHS = {
  company_name: 200,
  supplies_other: 200,
  country: 100,
  full_address: 500,
  mobile: 30,
  whatsapp: 30,
  email: 254, // RFC 5321 max
  sample_delivery_time: 50,
  payment_mode: 50,
  lab_dip_time: 50,
  lab_dip_charge: 10,
  lab_dip_amount: 100,
};

// Loose but real phone-number shape check: digits, optional leading +,
// optional spaces/dashes/parens, roughly 7-20 digits total. Not a full
// international-format validator, but catches obvious garbage (letters,
// single characters, random text) that the old "just non-empty" check let
// through.
const PHONE_PATTERN = /^\+?[\d\s\-()]{7,20}$/;

function validateSubmission(body) {
  const errors = [];

  // Honeypot: a field named to look plausible to an automated form-filler,
  // hidden from real users via CSS on the frontend. Real visitors never see
  // or fill it; most simple bots fill every field they find. Any non-empty
  // value here is treated as spam.
  if (body.website_url) {
    // Deliberately vague error, and deliberately still a 400 rather than a
    // distinct signal — no reason to tell a bot exactly which check it hit.
    errors.push('Submission could not be processed.');
    return { errors, supplies: [] };
  }

  for (const field of REQUIRED_FIELDS) {
    if (!body[field] || String(body[field]).trim() === '') {
      errors.push(`${field} is required.`);
    }
  }

  // Length caps — applied to whatever was provided, required or not, since
  // an attacker doesn't need a field to be required to abuse it.
  for (const [field, max] of Object.entries(MAX_LENGTHS)) {
    if (body[field] && String(body[field]).length > max) {
      errors.push(`${field} must be ${max} characters or fewer.`);
    }
  }

  const supplies = Array.isArray(body.supplies) ? body.supplies : String(body.supplies || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (supplies.length === 0) {
    errors.push('At least one "supplies" category is required.');
  }
  if (supplies.length > VALID_SUPPLIES.length) {
    errors.push('Too many supplies categories provided.');
  }
  const invalidSupplies = supplies.filter((s) => !VALID_SUPPLIES.includes(s));
  if (invalidSupplies.length > 0) {
    errors.push(`Invalid supplies categories: ${invalidSupplies.join(', ')}`);
  }
  if (supplies.includes('Others') && !body.supplies_other) {
    errors.push('"supplies_other" is required when "Others" is selected.');
  }

  if (body.payment_mode && !VALID_PAYMENT_MODES.includes(body.payment_mode)) {
    errors.push(`Invalid payment_mode. Must be one of: ${VALID_PAYMENT_MODES.join(', ')}`);
  }

  if (supplies.includes('Fabric')) {
    if (!body.lab_dip_time) errors.push('lab_dip_time is required when Fabric is selected.');
    if (!body.lab_dip_charge || !['Yes', 'No'].includes(body.lab_dip_charge)) {
      errors.push('lab_dip_charge (Yes/No) is required when Fabric is selected.');
    }
  }

  if (body.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
    errors.push('email is not a valid email address.');
  }

  if (body.mobile && !PHONE_PATTERN.test(body.mobile)) {
    errors.push('mobile does not look like a valid phone number.');
  }
  if (body.whatsapp && !PHONE_PATTERN.test(body.whatsapp)) {
    errors.push('whatsapp does not look like a valid phone number.');
  }

  return { errors, supplies };
}

// ── POST /api/suppliers — public submission endpoint ──────────
app.post('/api/suppliers', submitLimiter, async (req, res) => {
  try {
    const { errors, supplies } = validateSubmission(req.body);
    if (errors.length > 0) {
      return res.status(400).json({ success: false, errors });
    }

    const record = {
      company_name: req.body.company_name.trim(),
      supplies: supplies.join(', '),
      supplies_other: req.body.supplies_other || null,
      country: req.body.country.trim(),
      full_address: req.body.full_address.trim(),
      mobile: req.body.mobile.trim(),
      whatsapp: req.body.whatsapp.trim(),
      email: req.body.email.trim(),
      sample_delivery_time: req.body.sample_delivery_time.trim(),
      payment_mode: req.body.payment_mode.trim(),
      lab_dip_time: req.body.lab_dip_time || null,
      lab_dip_charge: req.body.lab_dip_charge || null,
      lab_dip_amount: req.body.lab_dip_amount || null,
      // [TODO] File upload (company profile PDF) is NOT wired to storage
      // yet. This backend has no file storage (e.g. S3/R2) configured.
      // Accepting a file here would need a separate upload step before
      // this endpoint — deliberately left out until that's decided,
      // rather than silently dropping/losing uploaded files.
      profile_file_url: null,
      ip_address: req.ip || null,
      user_agent: req.headers['user-agent'] || null,
    };

    // Explicit duplicate check (rather than relying only on the DB's unique
    // constraint) so we can return a clear, specific message instead of a
    // raw constraint-violation error.
    const existing = await db.execute({
      sql: `SELECT id FROM suppliers WHERE email = ? AND mobile = ? LIMIT 1`,
      args: [record.email, record.mobile],
    });
    if (existing.rows.length > 0) {
      return res.status(409).json({
        success: false,
        errors: ['This company\'s information is already in our database. If anything has changed, please contact us directly.'],
      });
    }

    await db.execute({
      sql: `INSERT INTO suppliers
        (company_name, supplies, supplies_other, country, full_address, mobile, whatsapp, email, sample_delivery_time, payment_mode, lab_dip_time, lab_dip_charge, lab_dip_amount, profile_file_url, ip_address, user_agent)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        record.company_name, record.supplies, record.supplies_other, record.country,
        record.full_address, record.mobile, record.whatsapp, record.email,
        record.sample_delivery_time, record.payment_mode, record.lab_dip_time,
        record.lab_dip_charge, record.lab_dip_amount, record.profile_file_url,
        record.ip_address, record.user_agent,
      ],
    });

    // Fire-and-continue: email failures must not fail the submission,
    // since the record is already safely stored at this point.
    sendSupplierConfirmation(record).catch((err) => console.error('Supplier confirmation error:', err));
    sendInternalNotification(record).catch((err) => console.error('Internal notification error:', err));

    res.status(201).json({
      success: true,
      message: 'Your information has been received.',
      footprint: {
        ip_address: record.ip_address,
        user_agent: record.user_agent,
        submitted_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error('Submission error:', err);
    res.status(500).json({ success: false, errors: ['Internal server error. Please try again.'] });
  }
});

// ─────────────────────────────────────────────────────────────
// ── GET /api/admin/suppliers — internal search/filter endpoint ──
// [SECURITY — NOT YET DONE]: This endpoint has NO AUTHENTICATION
// wired in yet. Per supplier-portal-spec.md Section 7, this data
// must be internal-only / SDF-visible-only. Do NOT deploy this
// publicly reachable without an auth check in front of it (e.g.
// a shared admin password header, or a proper login system).
// A basic placeholder check is included below (ADMIN_API_KEY env
// var) — replace with something stronger before real use.
// ─────────────────────────────────────────────────────────────
app.get('/api/admin/suppliers', adminLimiter, async (req, res) => {
  const providedKey = req.headers['x-admin-key'];
  const expectedKey = process.env.ADMIN_API_KEY;

  // Timing-safe comparison: a plain !== comparison leaks timing
  // information (it returns as soon as the first differing character is
  // found), which in theory lets an attacker guess the key one character
  // at a time by measuring response time. crypto.timingSafeEqual always
  // takes the same time regardless of where strings differ.
  const isAuthorized =
    !!expectedKey &&
    !!providedKey &&
    typeof providedKey === 'string' &&
    providedKey.length === expectedKey.length &&
    crypto.timingSafeEqual(Buffer.from(providedKey), Buffer.from(expectedKey));

  if (!isAuthorized) {
    return res.status(401).json({ success: false, errors: ['Unauthorized.'] });
  }

  const { category, country, paymentMode, q } = req.query;
  let sql = 'SELECT * FROM suppliers WHERE 1=1';
  const args = [];

  if (category) {
    sql += ' AND supplies LIKE ?';
    args.push(`%${category}%`);
  }
  if (country) {
    sql += ' AND country = ?';
    args.push(country);
  }
  if (paymentMode) {
    sql += ' AND payment_mode = ?';
    args.push(paymentMode);
  }
  if (q) {
    sql += ' AND (company_name LIKE ? OR full_address LIKE ?)';
    args.push(`%${q}%`, `%${q}%`);
  }

  sql += ' ORDER BY created_at DESC';

  try {
    const result = await db.execute({ sql, args });
    res.json({ success: true, count: result.rows.length, suppliers: result.rows });
  } catch (err) {
    console.error('Admin query error:', err);
    res.status(500).json({ success: false, errors: ['Internal server error.'] });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;

initSchema()
  .then(() => {
    app.listen(PORT, () => console.log(`Supplier backend running on port ${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to initialize database schema:', err);
    process.exit(1);
  });
