// ─────────────────────────────────────────────────────────────
// Resend email notifications.
// RESEND_API_KEY comes from environment variable.
//
// sdfltd.com is verified in the Resend Dashboard (confirmed), so
// RESEND_FROM_ADDRESS can be a real @sdfltd.com address.
//
// Reply-To is set separately from From/To, on purpose: notifications
// go out from supplier@sdfltd.com and land in an internal inbox, but
// if anyone replies to that notification, it should go to
// RESEND_REPLY_TO_ADDRESS (contact@sdfltd.com) — not back into the
// internal inbox, which should stay unexposed.
// ─────────────────────────────────────────────────────────────
import { Resend } from 'resend';

if (!process.env.RESEND_API_KEY) {
  throw new Error('Missing RESEND_API_KEY environment variable.');
}

const resend = new Resend(process.env.RESEND_API_KEY);

const FROM_ADDRESS = process.env.RESEND_FROM_ADDRESS || 'onboarding@resend.dev'; // [VERIFY] switch to a verified sdfltd.com address once domain is set up in Resend
const NOTIFY_TO = process.env.SUPPLIER_NOTIFY_EMAIL; // where SDF's team receives new-submission alerts (internal inbox)
const REPLY_TO_ADDRESS = process.env.RESEND_REPLY_TO_ADDRESS || FROM_ADDRESS; // where a reply to this notification should go — keeps the internal inbox out of any reply chain

export async function sendSupplierNotification(record) {
  if (!NOTIFY_TO) {
    console.warn('SUPPLIER_NOTIFY_EMAIL not set — skipping email notification.');
    return { skipped: true };
  }

  const html = `
    <h2>New Supplier Registration</h2>
    <p><strong>Company / Individual:</strong> ${escapeHtml(record.company_name)}</p>
    <p><strong>Supplies:</strong> ${escapeHtml(record.supplies)}${record.supplies_other ? ` (${escapeHtml(record.supplies_other)})` : ''}</p>
    <p><strong>Country:</strong> ${escapeHtml(record.country)}</p>
    <p><strong>Address:</strong> ${escapeHtml(record.full_address)}</p>
    <p><strong>Mobile:</strong> ${escapeHtml(record.mobile)}</p>
    <p><strong>WhatsApp:</strong> ${escapeHtml(record.whatsapp)}</p>
    <p><strong>Email:</strong> ${escapeHtml(record.email)}</p>
    <p><strong>Sample delivery time:</strong> ${escapeHtml(record.sample_delivery_time)}</p>
    <p><strong>Payment mode:</strong> ${escapeHtml(record.payment_mode)}</p>
    ${record.lab_dip_time ? `<p><strong>Lab dip time:</strong> ${escapeHtml(record.lab_dip_time)}</p>` : ''}
    ${record.lab_dip_charge ? `<p><strong>Lab dip charge:</strong> ${escapeHtml(record.lab_dip_charge)}${record.lab_dip_amount ? ` (${escapeHtml(record.lab_dip_amount)})` : ''}</p>` : ''}
    <p style="color:#888;font-size:0.85rem;">Submitted via supplier.sdfltd.com</p>
  `;

  // Strip CR/LF from anything going into the Subject header — company_name
  // is public, unauthenticated form input, and a newline there could be used
  // to inject extra email headers (header injection).
  const safeCompanyName = String(record.company_name).replace(/[\r\n]/g, ' ');

  const { data, error } = await resend.emails.send({
    from: `SDF Supplier Portal <${FROM_ADDRESS}>`,
    to: [NOTIFY_TO],
    replyTo: REPLY_TO_ADDRESS,
    subject: `New Supplier Registration — ${safeCompanyName}`,
    html,
  });

  if (error) {
    // Don't throw — a failed notification email should not fail the whole
    // submission. The record is already saved in Turso by this point.
    console.error('Resend email failed:', error);
    return { success: false, error };
  }
  return { success: true, data };
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
