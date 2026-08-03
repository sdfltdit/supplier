// ─────────────────────────────────────────────────────────────
// Resend email notifications.
// RESEND_API_KEY comes from environment variable.
//
// [IMPORTANT — SETUP STEP NOT YET DONE]:
// To send FROM an sdfltd.com address (e.g. notifications@sdfltd.com),
// that domain must first be verified in the Resend Dashboard
// (Resend > Domains > Add Domain > add the DNS records they give you
// in Cloudflare). Until that's done, sending will fail for a custom
// "from" address — Resend's own onboarding@resend.dev sender works
// without verification, as a fallback for testing only.
// ─────────────────────────────────────────────────────────────
import { Resend } from 'resend';

if (!process.env.RESEND_API_KEY) {
  throw new Error('Missing RESEND_API_KEY environment variable.');
}

const resend = new Resend(process.env.RESEND_API_KEY);

const FROM_ADDRESS = process.env.RESEND_FROM_ADDRESS || 'onboarding@resend.dev'; // [VERIFY] switch to a verified sdfltd.com address once domain is set up in Resend
const NOTIFY_TO = process.env.SUPPLIER_NOTIFY_EMAIL; // where SDF's team receives new-submission alerts

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

  const { data, error } = await resend.emails.send({
    from: `SDF Supplier Portal <${FROM_ADDRESS}>`,
    to: [NOTIFY_TO],
    subject: `New Supplier Registration — ${record.company_name}`,
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
