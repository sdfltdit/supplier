import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { db, initSchema } from './db.js';
import { sendSupplierConfirmation, sendInternalNotification } from './email.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());

// Render sits behind its own reverse proxy, so without this, req.ip would
// return Render's internal proxy address instead of the real visitor IP.
// 'trust proxy' tells Express to read the X-Forwarded-For header instead.
app.set('trust proxy', true);

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

const REQUIRED_FIELDS = [
  'company_name', 'supplies', 'country', 'full_address',
  'mobile', 'whatsapp', 'email', 'sample_delivery_time', 'payment_mode',
];

const VALID_PAYMENT_MODES = ['LC', 'TT', 'Cash', 'Others'];
const VALID_SUPPLIES = ['Fabric', 'Yarn', 'Trims', 'Chemical', 'Print', 'Embroidery', 'Wash / Stone', 'Packaging', 'Others'];

function validateSubmission(body) {
  const errors = [];

  for (const field of REQUIRED_FIELDS) {
    if (!body[field] || String(body[field]).trim() === '') {
      errors.push(`${field} is required.`);
    }
  }

  const supplies = Array.isArray(body.supplies) ? body.supplies : String(body.supplies || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (supplies.length === 0) {
    errors.push('At least one "supplies" category is required.');
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

  return { errors, supplies };
}

// ── POST /api/suppliers — public submission endpoint ──────────
app.post('/api/suppliers', async (req, res) => {
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
app.get('/api/admin/suppliers', async (req, res) => {
  const providedKey = req.headers['x-admin-key'];
  if (!process.env.ADMIN_API_KEY || providedKey !== process.env.ADMIN_API_KEY) {
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
