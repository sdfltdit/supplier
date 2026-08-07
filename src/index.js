import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { timingSafeEqual } from 'node:crypto';
import { UAParser } from 'ua-parser-js';
import { getDb, initSchema } from './db.js';
import { sendSupplierConfirmation, sendInternalNotification } from './email.js';

const app = new Hono();

// ── CORS (only the real supplier-facing site can call /api/*) ──
app.use('/api/*', async (c, next) => {
  const mw = cors({ origin: c.env.ALLOWED_ORIGIN || 'https://supplier.sdfltd.com' });
  return mw(c, next);
});

// ─────────────────────────────────────────────────────────────
// Rate limiting via Workers KV. Replaces express-rate-limit, whose
// in-memory counters only worked because Render ran one long-lived
// process — Workers spins up many short-lived isolates, so counting
// needs to live somewhere shared. KV is eventually-consistent (fine
// here: this is abuse-deterrence, not a hard security boundary).
// If RATE_LIMIT_KV isn't bound, this fails OPEN (allows the request)
// rather than breaking the whole endpoint.
// ─────────────────────────────────────────────────────────────
async function checkRateLimit(env, key, windowSeconds, max) {
  if (!env.RATE_LIMIT_KV) return true;
  const now = Date.now();
  let entry;
  try {
    const raw = await env.RATE_LIMIT_KV.get(key);
    entry = raw ? JSON.parse(raw) : null;
  } catch {
    entry = null;
  }
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + windowSeconds * 1000 };
  }
  entry.count += 1;
  await env.RATE_LIMIT_KV.put(key, JSON.stringify(entry), { expirationTtl: windowSeconds + 5 });
  return entry.count <= max;
}

// ── Client IP: Cloudflare always sets this at the edge, unspoofable
// by the client — much simpler and more reliable than the old
// X-Forwarded-For-chain-walking logic Render's proxy required. ──
function getClientIp(c) {
  return c.req.header('cf-connecting-ip') || null;
}

async function lookupIpInfo(ip) {
  const empty = { country: null, city: null, isp: null, isProxyOrVpn: null };
  if (!ip) return empty;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(
      `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,city,isp,proxy,hosting`,
      { signal: controller.signal }
    );
    clearTimeout(timeout);
    if (!res.ok) return empty;
    const data = await res.json();
    if (data.status !== 'success') return empty;
    return {
      country: data.country || null,
      city: data.city || null,
      isp: data.isp || null,
      isProxyOrVpn: Boolean(data.proxy || data.hosting),
    };
  } catch (err) {
    console.error('IP geolocation lookup failed (non-fatal):', err.message);
    return empty;
  }
}

function parseUserAgent(uaString) {
  if (!uaString) return { browserName: null, osName: null, deviceType: null };
  try {
    const parser = new UAParser(uaString);
    const result = parser.getResult();
    const browserName = result.browser.name
      ? `${result.browser.name}${result.browser.major ? ' ' + result.browser.major : ''}`
      : null;
    const osName = result.os.name
      ? `${result.os.name}${result.os.version ? ' ' + result.os.version : ''}`
      : null;
    const deviceType = result.device.type || 'desktop';
    return { browserName, osName, deviceType };
  } catch (err) {
    console.error('User-agent parsing failed (non-fatal):', err.message);
    return { browserName: null, osName: null, deviceType: null };
  }
}

const REQUIRED_FIELDS = [
  'company_name', 'supplies', 'country', 'full_address',
  'mobile', 'whatsapp', 'email', 'sample_delivery_time', 'payment_mode',
];
const VALID_PAYMENT_MODES = ['LC', 'TT', 'Cash', 'Others'];
const VALID_SUPPLIES = ['Fabric', 'Yarn', 'Trims', 'Chemical', 'Print', 'Embroidery', 'Wash / Stone', 'Packaging', 'Others'];
const MAX_LENGTHS = {
  company_name: 200, supplies_other: 200, country: 100, full_address: 500,
  mobile: 30, whatsapp: 30, email: 254, sample_delivery_time: 50,
  payment_mode: 50, lab_dip_time: 50, lab_dip_charge: 10, lab_dip_amount: 100,
};
const PHONE_PATTERN = /^\+?[\d\s\-()]{7,20}$/;
const MAX_PROFILE_FILE_MB = 5;

const BLOCKED_EMAIL_DOMAINS = ['sdfltd.com'];
const BLOCKED_EMAILS = ['sdfltdit@gmail.com'];
const BLOCKED_PHONES_RAW = ['+8801819172080', '+8801711160511', '+16465356343', '+8801309001058'];

function normalizePhone(raw) {
  return String(raw || '').replace(/\D/g, '');
}
function phoneVariants(digitsOnly) {
  const variants = new Set([digitsOnly]);
  if (digitsOnly.startsWith('880') && digitsOnly.length === 13) variants.add('0' + digitsOnly.slice(3));
  if (digitsOnly.startsWith('0') && digitsOnly.length === 11) variants.add('880' + digitsOnly.slice(1));
  return variants;
}
const BLOCKED_PHONE_DIGIT_SETS = BLOCKED_PHONES_RAW.map((p) => phoneVariants(normalizePhone(p)));
function isBlockedPhone(raw) {
  const digits = normalizePhone(raw);
  if (!digits) return false;
  return BLOCKED_PHONE_DIGIT_SETS.some((set) => set.has(digits));
}
function isBlockedEmail(raw) {
  const email = String(raw || '').trim().toLowerCase();
  if (!email) return false;
  if (BLOCKED_EMAILS.includes(email)) return true;
  const domain = email.split('@')[1];
  return !!domain && BLOCKED_EMAIL_DOMAINS.includes(domain);
}

function validateSubmission(body) {
  const errors = [];

  if (body.website_url) {
    errors.push('Submission could not be processed.');
    return { errors, supplies: [] };
  }

  for (const field of REQUIRED_FIELDS) {
    if (!body[field] || String(body[field]).trim() === '') {
      errors.push(`${field} is required.`);
    }
  }

  for (const [field, max] of Object.entries(MAX_LENGTHS)) {
    if (body[field] && String(body[field]).length > max) {
      errors.push(`${field} must be ${max} characters or fewer.`);
    }
  }

  const supplies = Array.isArray(body.supplies)
    ? body.supplies
    : String(body.supplies || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (supplies.length === 0) errors.push('At least one "supplies" category is required.');
  if (supplies.length > VALID_SUPPLIES.length) errors.push('Too many supplies categories provided.');
  const invalidSupplies = supplies.filter((s) => !VALID_SUPPLIES.includes(s));
  if (invalidSupplies.length > 0) errors.push(`Invalid supplies categories: ${invalidSupplies.join(', ')}`);
  if (supplies.includes('Others') && !body.supplies_other) errors.push('"supplies_other" is required when "Others" is selected.');

  if (body.payment_mode && !VALID_PAYMENT_MODES.includes(body.payment_mode)) {
    errors.push(`Invalid payment_mode. Must be one of: ${VALID_PAYMENT_MODES.join(', ')}`);
  }

  if (supplies.includes('Fabric')) {
    if (!body.lab_dip_time) errors.push('lab_dip_time is required when Fabric is selected.');
    if (!body.lab_dip_charge || !['Yes', 'No'].includes(body.lab_dip_charge)) {
      errors.push('lab_dip_charge (Yes/No) is required when Fabric is selected.');
    }
  }

  if (body.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) errors.push('email is not a valid email address.');
  if (body.email && isBlockedEmail(body.email)) errors.push('Submission could not be processed.');

  if (body.mobile && !PHONE_PATTERN.test(body.mobile)) errors.push('mobile does not look like a valid phone number.');
  if (body.whatsapp && !PHONE_PATTERN.test(body.whatsapp)) errors.push('whatsapp does not look like a valid phone number.');
  if ((body.mobile && isBlockedPhone(body.mobile)) || (body.whatsapp && isBlockedPhone(body.whatsapp))) {
    errors.push('Submission could not be processed.');
  }

  return { errors, supplies };
}

function timingSafeStringEqual(a, b) {
  if (!a || !b || typeof a !== 'string' || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function isAuthorized(c) {
  const providedKey = c.req.header('x-admin-key') || c.req.query('key');
  const expectedKey = c.env.ADMIN_API_KEY;
  return !!expectedKey && timingSafeStringEqual(providedKey, expectedKey);
}

// ── GET /health ──────────────────────────────────────────────
app.get('/health', (c) => c.json({ status: 'ok' }));

// ── POST /api/suppliers — public submission endpoint ──────────
app.post('/api/suppliers', async (c) => {
  const clientIp = getClientIp(c);

  const allowed = await checkRateLimit(c.env, `submit:${clientIp || 'unknown'}`, 60 * 60, 5);
  if (!allowed) {
    return c.json({ success: false, errors: ['Too many submissions from this connection. Please try again later, or contact us directly.'] }, 429);
  }

  try {
    const body = await c.req.parseBody();
    const { errors, supplies } = validateSubmission(body);

    let profileFileName = null;
    let profileFileData = null;
    const file = body['profile_file'];
    if (file && typeof file === 'object' && typeof file.arrayBuffer === 'function' && file.size > 0) {
      if (file.type !== 'application/pdf') {
        errors.push('Only PDF files are accepted for the company profile.');
      } else if (file.size > MAX_PROFILE_FILE_MB * 1024 * 1024) {
        errors.push(`Company profile file must be ${MAX_PROFILE_FILE_MB}MB or smaller.`);
      } else {
        const buf = new Uint8Array(await file.arrayBuffer());
        const header = new TextDecoder('ascii').decode(buf.slice(0, 5));
        if (header !== '%PDF-') {
          errors.push('The uploaded file does not appear to be a valid PDF.');
        } else {
          profileFileName = String(file.name || 'company-profile.pdf').slice(0, 255);
          profileFileData = Buffer.from(buf).toString('base64');
        }
      }
    }

    if (errors.length > 0) {
      return c.json({ success: false, errors }, 400);
    }

    const uaString = c.req.header('user-agent') || null;
    const { browserName, osName, deviceType } = parseUserAgent(uaString);
    const ipInfo = await lookupIpInfo(clientIp);

    const record = {
      company_name: String(body.company_name).trim(),
      supplies: supplies.join(', '),
      supplies_other: body.supplies_other || null,
      country: String(body.country).trim(),
      full_address: String(body.full_address).trim(),
      mobile: String(body.mobile).trim(),
      whatsapp: String(body.whatsapp).trim(),
      email: String(body.email).trim(),
      sample_delivery_time: String(body.sample_delivery_time).trim(),
      payment_mode: String(body.payment_mode).trim(),
      lab_dip_time: body.lab_dip_time || null,
      lab_dip_charge: body.lab_dip_charge || null,
      lab_dip_amount: body.lab_dip_amount || null,
      profile_file_name: profileFileName,
      profile_file_data: profileFileData,
      ip_address: clientIp,
      user_agent: uaString,
      browser_name: browserName,
      os_name: osName,
      device_type: deviceType,
      referrer: c.req.header('referer') || c.req.header('referrer') || null,
      accept_language: c.req.header('accept-language') || null,
      ip_country: ipInfo.country,
      ip_city: ipInfo.city,
      ip_isp: ipInfo.isp,
      ip_is_proxy_or_vpn: ipInfo.isProxyOrVpn,
    };

    const db = getDb(c.env);
    await initSchema(db);

    const existing = await db.execute({
      sql: `SELECT id FROM suppliers WHERE email = ? AND mobile = ? LIMIT 1`,
      args: [record.email, record.mobile],
    });
    if (existing.rows.length > 0) {
      return c.json({
        success: false,
        errors: ['This company\'s information is already in our database. If anything has changed, please contact us directly.'],
      }, 409);
    }

    await db.execute({
      sql: `INSERT INTO suppliers
        (company_name, supplies, supplies_other, country, full_address, mobile, whatsapp, email, sample_delivery_time, payment_mode, lab_dip_time, lab_dip_charge, lab_dip_amount, profile_file_name, profile_file_data, ip_address, user_agent, browser_name, os_name, device_type, referrer, accept_language, ip_country, ip_city, ip_isp, ip_is_proxy_or_vpn)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        record.company_name, record.supplies, record.supplies_other, record.country,
        record.full_address, record.mobile, record.whatsapp, record.email,
        record.sample_delivery_time, record.payment_mode, record.lab_dip_time,
        record.lab_dip_charge, record.lab_dip_amount, record.profile_file_name,
        record.profile_file_data, record.ip_address, record.user_agent,
        record.browser_name, record.os_name, record.device_type,
        record.referrer, record.accept_language, record.ip_country,
        record.ip_city, record.ip_isp, record.ip_is_proxy_or_vpn === null ? null : (record.ip_is_proxy_or_vpn ? 1 : 0),
      ],
    });

    // Fire-and-continue via waitUntil: lets the response return immediately
    // while the emails still finish sending in the background, instead of
    // making the submitter wait on Resend. Failures here are logged, not
    // thrown — the record is already safely stored.
    c.executionCtx.waitUntil(
      sendSupplierConfirmation(record, c.env).catch((err) => console.error('Supplier confirmation error:', err))
    );
    c.executionCtx.waitUntil(
      sendInternalNotification(record, c.env).catch((err) => console.error('Internal notification error:', err))
    );

    return c.json({ success: true, message: 'Your information has been received.' }, 201);
  } catch (err) {
    console.error('Submission error:', err);
    return c.json({ success: false, errors: ['Internal server error. Please try again.'] }, 500);
  }
});

// ── GET /api/admin/suppliers — internal search/filter endpoint ──
app.get('/api/admin/suppliers', async (c) => {
  const clientIp = getClientIp(c);
  const allowed = await checkRateLimit(c.env, `admin:${clientIp || 'unknown'}`, 15 * 60, 20);
  if (!allowed) {
    return c.json({ success: false, errors: ['Too many requests. Please try again later.'] }, 429);
  }
  if (!isAuthorized(c)) {
    return c.json({ success: false, errors: ['Unauthorized.'] }, 401);
  }

  const category = c.req.query('category');
  const country = c.req.query('country');
  const paymentMode = c.req.query('paymentMode');
  const q = c.req.query('q');

  let sql = `SELECT id, company_name, supplies, supplies_other, country, full_address,
    mobile, whatsapp, email, sample_delivery_time, payment_mode, lab_dip_time,
    lab_dip_charge, lab_dip_amount, profile_file_name,
    (profile_file_data IS NOT NULL) AS has_profile_file,
    ip_address, user_agent, browser_name, os_name, device_type, referrer,
    accept_language, ip_country, ip_city, ip_isp, ip_is_proxy_or_vpn, created_at
    FROM suppliers WHERE 1=1`;
  const args = [];

  if (category) { sql += ' AND supplies LIKE ?'; args.push(`%${category}%`); }
  if (country) { sql += ' AND country = ?'; args.push(country); }
  if (paymentMode) { sql += ' AND payment_mode = ?'; args.push(paymentMode); }
  if (q) { sql += ' AND (company_name LIKE ? OR full_address LIKE ?)'; args.push(`%${q}%`, `%${q}%`); }

  sql += ' ORDER BY created_at DESC';

  try {
    const db = getDb(c.env);
    const result = await db.execute({ sql, args });
    return c.json({ success: true, count: result.rows.length, suppliers: result.rows });
  } catch (err) {
    console.error('Admin query error:', err);
    return c.json({ success: false, errors: ['Internal server error.'] }, 500);
  }
});

// ── GET /api/admin/suppliers/:id/profile-file ──────────────────
app.get('/api/admin/suppliers/:id/profile-file', async (c) => {
  const clientIp = getClientIp(c);
  const allowed = await checkRateLimit(c.env, `admin:${clientIp || 'unknown'}`, 15 * 60, 20);
  if (!allowed) {
    return c.json({ success: false, errors: ['Too many requests. Please try again later.'] }, 429);
  }
  if (!isAuthorized(c)) {
    return c.json({ success: false, errors: ['Unauthorized.'] }, 401);
  }

  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ success: false, errors: ['Invalid supplier id.'] }, 400);
  }

  try {
    const db = getDb(c.env);
    const result = await db.execute({
      sql: `SELECT profile_file_name, profile_file_data FROM suppliers WHERE id = ? LIMIT 1`,
      args: [id],
    });
    const row = result.rows[0];
    if (!row || !row.profile_file_data) {
      return c.json({ success: false, errors: ['No profile file on record for this supplier.'] }, 404);
    }
    const buffer = Buffer.from(row.profile_file_data, 'base64');
    const filename = String(row.profile_file_name || 'company-profile.pdf').replace(/"/g, '');
    return new Response(buffer, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    console.error('Profile file fetch error:', err);
    return c.json({ success: false, errors: ['Internal server error.'] }, 500);
  }
});

export default app;
