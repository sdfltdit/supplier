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
  const rows = [
    ['Company / Individual', record.company_name],
    ['Supplies', record.supplies + (record.supplies_other ? ` (${record.supplies_other})` : '')],
    ['Country', record.country],
    ['Address', record.full_address],
    ['Mobile', record.mobile],
    ['WhatsApp', record.whatsapp],
    ['Email', record.email],
    ['Sample delivery time', record.sample_delivery_time],
    ['Payment mode', record.payment_mode],
  ];
  if (record.lab_dip_time) rows.push(['Lab dip time', record.lab_dip_time]);
  if (record.lab_dip_charge) rows.push(['Lab dip charge', record.lab_dip_charge + (record.lab_dip_amount ? ` (${record.lab_dip_amount})` : '')]);

  return `
    <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:20px 0;">
      ${rows.map(([label, value]) => `
        <tr>
          <td style="padding:10px 12px;border-bottom:1px solid #eee;color:#666;font-size:13px;width:180px;vertical-align:top;">${escapeHtml(label)}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #eee;color:#111;font-size:14px;vertical-align:top;">${escapeHtml(value)}</td>
        </tr>
      `).join('')}
    </table>
  `;
}

function emailWrapper(bodyHtml) {
  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;color:#111;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-bottom:2px solid #e00;padding-bottom:20px;margin-bottom:24px;">
        <tr>
          <td align="center">
            <img src="https://supplier.sdfltd.com/logo.jpg" alt="SDF Clothing" width="110" height="96" style="display:block;border:0;margin:0 auto 12px;" />
            <div style="font-size:20px;font-weight:700;letter-spacing:0.04em;">SDF CLOTHING</div>
          </td>
        </tr>
      </table>
      ${bodyHtml}
      <div style="margin-top:32px;padding-top:16px;border-top:1px solid #eee;color:#999;font-size:12px;line-height:1.6;">
        SDF Clothing &middot; Dhaka, Bangladesh &middot; <a href="https://sdfltd.com" style="color:#999;">sdfltd.com</a>
      </div>
    </div>
  `;
}

// ── 1. Confirmation email TO the supplier ──────────────────────
export async function sendSupplierConfirmation(record) {
  if (!record.email) {
    console.warn('No supplier email on record — skipping confirmation email.');
    return { skipped: true };
  }

  const body = `
    <p style="font-size:15px;line-height:1.6;margin:0 0 8px;">Dear ${escapeHtml(record.company_name)},</p>
    <p style="font-size:15px;line-height:1.6;margin:0 0 8px;">
      Thank you for your interest in supplying to SDF Clothing. We confirm the following
      details have been received and are on file with us:
    </p>
    ${buildRecordSummaryHtml(record)}
    <p style="font-size:13px;line-height:1.6;color:#666;margin:0;">
      This does not constitute a Purchase Order or business commitment. Under our
      <a href="https://sdfltd.com/terms" style="color:#e00;">Terms &amp; Conditions</a>, an order is
      confirmed only upon a signed Purchase Order, advance payment, and sample approval.
      If any of the information above needs to be corrected, simply reply to this email.
    </p>
  `;

  const { data, error } = await resend.emails.send({
    from: `SDF Clothing <${FROM_ADDRESS}>`,
    to: [record.email],
    replyTo: REPLY_TO_ADDRESS,
    subject: `SDF Clothing — Information Received`,
    html: emailWrapper(body),
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

  const submittedAt = new Date().toLocaleString('en-US', { timeZone: 'Asia/Dhaka', dateStyle: 'medium', timeStyle: 'short' });

  const locationParts = [record.ip_city, record.ip_country].filter(Boolean).join(', ');

  const trackingRows = [
    ['Submitted (Dhaka time)', submittedAt],
    ['IP address', record.ip_address || 'Not available'],
    ['Location (from IP)', locationParts || 'Not available'],
    ['ISP / Network', record.ip_isp || 'Not available'],
    ['Proxy / VPN / Datacenter IP', record.ip_is_proxy_or_vpn === null ? 'Unknown' : (record.ip_is_proxy_or_vpn ? 'Yes — review' : 'No')],
    ['Browser', record.browser_name || 'Not available'],
    ['Operating system', record.os_name || 'Not available'],
    ['Device type', record.device_type || 'Not available'],
    ['Referring page', record.referrer || 'Direct / none'],
    ['Browser language', record.accept_language || 'Not available'],
  ];

  const body = `
    <p style="font-size:15px;line-height:1.6;margin:0 0 4px;">New supplier entry submitted:</p>
    ${buildRecordSummaryHtml(record)}
    ${record.profile_file_data ? `<p style="font-size:13px;color:#444;margin:0 0 8px;">Company profile attached: ${escapeHtml(record.profile_file_name || 'profile.pdf')}</p>` : ''}
    <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:16px 0 0;background:#fafafa;border:1px solid #eee;border-radius:4px;">
      <tr><td colspan="2" style="padding:8px 12px;font-size:10px;letter-spacing:0.06em;text-transform:uppercase;color:#e00;font-weight:700;">Internal — Submission Tracking</td></tr>
      ${trackingRows.map(([label, value]) => `
        <tr>
          <td style="padding:6px 12px;color:#888;font-size:12px;width:170px;vertical-align:top;">${escapeHtml(label)}</td>
          <td style="padding:6px 12px;color:#333;font-size:12px;word-break:break-word;vertical-align:top;">${escapeHtml(value)}</td>
        </tr>
      `).join('')}
    </table>
    <p style="font-size:12px;color:#999;margin:8px 0 0;">Submitted via supplier.sdfltd.com</p>
  `;

  const { data, error } = await resend.emails.send({
    from: `SDF Supplier Portal <${FROM_ADDRESS}>`,
    to: [INTERNAL_NOTIFY_TO],
    replyTo: REPLY_TO_ADDRESS,
    subject: `New Supplier: ${safeSubjectPart(record.company_name)}`,
    html: emailWrapper(body),
    // Attach the uploaded PDF directly (base64, already stored that way in
    // Turso) when one exists, so staff have it in-hand without a separate
    // admin-API call. Omitted entirely when there's no file rather than
    // sending an empty/null attachments array.
    ...(record.profile_file_data
      ? { attachments: [{ filename: record.profile_file_name || 'company-profile.pdf', content: record.profile_file_data }] }
      : {}),
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
