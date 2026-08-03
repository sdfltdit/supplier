// ─────────────────────────────────────────────────────────────
// Resend email notifications.
// RESEND_API_KEY comes from environment variable.
// sdfltd.com is verified in the Resend Dashboard.
//
// Two separate emails are sent per submission:
//
// 1. sendSupplierConfirmation() — goes OUT to the supplier who submitted
//    the form, from supplier@sdfltd.com, confirming their data was
//    received. Reply-To is set to contact@sdfltd.com, so if the supplier
//    replies, it lands at the real SDF contact inbox, not this backend's
//    sending address.
//
// 2. sendInternalNotification() — goes to SDF's own internal inbox
//    (SUPPLIER_NOTIFY_EMAIL, e.g. sdfltdit@gmail.com) so SDF knows a new
//    submission came in. This one is never seen by the supplier, so
//    there's no need to hide the internal address here.
// ─────────────────────────────────────────────────────────────
import { Resend } from 'resend';

if (!process.env.RESEND_API_KEY) {
  throw new Error('Missing RESEND_API_KEY environment variable.');
}

const resend = new Resend(process.env.RESEND_API_KEY);

const FROM_ADDRESS = process.env.RESEND_FROM_ADDRESS || 'onboarding@resend.dev'; // e.g. supplier@sdfltd.com
const REPLY_TO_ADDRESS = process.env.RESEND_REPLY_TO_ADDRESS || FROM_ADDRESS;    // e.g. contact@sdfltd.com — where supplier replies should land
const INTERNAL_NOTIFY_TO = process.env.SUPPLIER_NOTIFY_EMAIL;                    // e.g. sdfltdit@gmail.com — SDF's own inbox, internal only

// Strip CR/LF from anything going into an email Subject header — form
// input is public/unauthenticated, and a newline there could be used to
// inject extra email headers.
function safeSubjectPart(str) {
  return String(str ?? '').replace(/[\r\n]/g, ' ');
}

function buildRecordSummaryHtml(record) {
  return `
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
  `;
}

// ── 1. Confirmation email TO the supplier ──────────────────────
export async function sendSupplierConfirmation(record) {
  if (!record.email) {
    console.warn('No supplier email on record — skipping confirmation email.');
    return { skipped: true };
  }

  const html = `
    <h2>We've received your registration</h2>
    <p>Thank you, ${escapeHtml(record.company_name)}. SDF Clothing Ltd has received the following information:</p>
    ${buildRecordSummaryHtml(record)}
    <p style="color:#888;font-size:0.85rem;">
      This confirms we have your information on file. Submission of this form does not
      constitute a Purchase Order or business commitment — see our
      <a href="https://sdfltd.com/terms">Terms &amp; Conditions</a> for details.
      If anything above is incorrect, reply to this email to let us know.
    </p>
  `;

  const { data, error } = await resend.emails.send({
    from: `SDF Clothing <${FROM_ADDRESS}>`,
    to: [record.email],
    replyTo: REPLY_TO_ADDRESS,
    subject: `We've received your supplier registration — SDF Clothing Ltd`,
    html,
  });

  if (error) {
    // Don't throw — a failed confirmation email should not fail the
    // submission. The record is already saved in Turso by this point.
    console.error('Supplier confirmation email failed:', error);
    return { success: false, error };
  }
  return { success: true, data };
}

// ── 2. Internal notification TO SDF's own inbox ─────────────────
export async function sendInternalNotification(record) {
  if (!INTERNAL_NOTIFY_TO) {
    console.warn('SUPPLIER_NOTIFY_EMAIL not set — skipping internal notification.');
    return { skipped: true };
  }

  const html = `
    <h2>New Supplier Registration</h2>
    ${buildRecordSummaryHtml(record)}
    <p style="color:#888;font-size:0.85rem;">Submitted via supplier.sdfltd.com</p>
  `;

  const { data, error } = await resend.emails.send({
    from: `SDF Supplier Portal <${FROM_ADDRESS}>`,
    to: [INTERNAL_NOTIFY_TO],
    replyTo: REPLY_TO_ADDRESS,
    subject: `New Supplier Registration — ${safeSubjectPart(record.company_name)}`,
    html,
  });

  if (error) {
    console.error('Internal notification email failed:', error);
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
