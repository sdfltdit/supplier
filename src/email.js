// ─────────────────────────────────────────────────────────────
// Resend email notifications. Same two-email behavior as before:
// 1. sendSupplierConfirmation() -> the supplier, from supplier@sdfltd.com,
//    Reply-To contact@sdfltd.com.
// 2. sendInternalNotification() -> SDF's internal inbox (SUPPLIER_NOTIFY_EMAIL).
// Reads config from `env` (Worker bindings/secrets) instead of
// process.env, since each request gets its own env object in Workers.
// ─────────────────────────────────────────────────────────────
import { Resend } from 'resend';

function safeSubjectPart(str) {
  return String(str ?? '').replace(/[\r\n]/g, ' ');
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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

export async function sendSupplierConfirmation(record, env) {
  if (!record.email) {
    console.warn('No supplier email on record — skipping confirmation email.');
    return { skipped: true };
  }

  const resend = new Resend(env.RESEND_API_KEY);
  const FROM_ADDRESS = env.RESEND_FROM_ADDRESS || 'onboarding@resend.dev';
  const REPLY_TO_ADDRESS = env.RESEND_REPLY_TO_ADDRESS || FROM_ADDRESS;

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
    console.error('Supplier confirmation email failed:', error);
    return { success: false, error };
  }
  return { success: true, data };
}

export async function sendInternalNotification(record, env) {
  const INTERNAL_NOTIFY_TO = env.SUPPLIER_NOTIFY_EMAIL;
  if (!INTERNAL_NOTIFY_TO) {
    console.warn('SUPPLIER_NOTIFY_EMAIL not set — skipping internal notification.');
    return { skipped: true };
  }

  const resend = new Resend(env.RESEND_API_KEY);
  const FROM_ADDRESS = env.RESEND_FROM_ADDRESS || 'onboarding@resend.dev';
  const REPLY_TO_ADDRESS = env.RESEND_REPLY_TO_ADDRESS || FROM_ADDRESS;

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
