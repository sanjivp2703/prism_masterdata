import 'server-only';
import nodemailer from 'nodemailer';

export function isEmailConfigured(): boolean {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function getTransport() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT ?? 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    throw new Error(
      'Email is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, and SMTP_PASS in .env.local',
    );
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
}

function getFrom() {
  return process.env.SMTP_FROM || process.env.SMTP_USER || 'Prism <noreply@prism.app>';
}

function getAppUrl() {
  return (process.env.APP_URL || 'http://localhost:8000').replace(/\/$/, '');
}

// ── Prism brand colors ────────────────────────────────────────────────────
const BRAND_NAVY  = '#1A1A2E';
const BRAND_BLUE  = '#378ADD';
const BRAND_BG    = '#F4F6F8';
const BRAND_MUTED = '#6B7280';

const ROLE_DESCRIPTIONS: Record<'admin' | 'user', { label: string; can: string[]; cannot: string[] }> = {
  admin: {
    label:  'Admin',
    can:    ['View and standardise data', 'Create and review runs', 'Export canonical mappings', 'Invite new users (admin or user)', 'Remove existing accounts'],
    cannot: [],
  },
  user: {
    label:  'User',
    can:    ['View and standardise data', 'Create and review runs', 'Export canonical mappings'],
    cannot: ['Invite new users', 'Remove accounts'],
  },
};

function roleBlock(role: 'admin' | 'user'): string {
  const desc = ROLE_DESCRIPTIONS[role];
  const canRows = desc.can.map(p => `
    <tr>
      <td style="padding:2px 0;font-size:12px;color:#374151;">
        <span style="color:#0F6E56;margin-right:6px;">✓</span>${p}
      </td>
    </tr>`).join('');
  const cannotRows = desc.cannot.map(p => `
    <tr>
      <td style="padding:2px 0;font-size:12px;color:#374151;">
        <span style="color:#A32D2D;margin-right:6px;">✗</span>${p}
      </td>
    </tr>`).join('');
  return `
    <div style="background:#F4F6F8;border-radius:8px;padding:14px 16px;margin-bottom:24px;">
      <p style="margin:0 0 8px;font-size:12px;font-weight:600;color:${BRAND_NAVY};">
        Your role: <span style="color:${BRAND_BLUE}">${desc.label}</span>
      </p>
      <table cellpadding="0" cellspacing="0" style="width:100%;">
        ${canRows}${cannotRows}
      </table>
    </div>`;
}

function inviteHtml(inviterName: string, inviterEmail: string, acceptUrl: string, role: 'admin' | 'user'): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>You've been invited to Prism</title>
</head>
<body style="margin:0;padding:0;background:${BRAND_BG};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND_BG};padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="520" cellpadding="0" cellspacing="0" style="background:#FFFFFF;border-radius:14px;border:0.5px solid #E5E7EB;overflow:hidden;">

          <!-- Header -->
          <tr>
            <td style="background:${BRAND_NAVY};padding:28px 36px;text-align:left;">
              <span style="font-size:22px;font-weight:600;color:#FFFFFF;letter-spacing:-0.3px;">Prism</span>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:36px 36px 28px;">
              <p style="margin:0 0 16px;font-size:16px;font-weight:600;color:${BRAND_NAVY};">
                You've been invited to Prism
              </p>
              <p style="margin:0 0 20px;font-size:14px;color:#374151;line-height:1.6;">
                <strong>${inviterName || inviterEmail}</strong> has invited you to join
                <strong>Prism</strong> as a <strong>${ROLE_DESCRIPTIONS[role].label}</strong> — a data
                standardisation platform for unifying inconsistent categorical values across
                your data warehouse's tables.
              </p>

              ${roleBlock(role)}

              <!-- CTA button -->
              <table cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
                <tr>
                  <td style="background:${BRAND_BLUE};border-radius:8px;">
                    <a href="${acceptUrl}"
                       style="display:inline-block;padding:12px 28px;font-size:14px;font-weight:600;color:#FFFFFF;text-decoration:none;letter-spacing:0.1px;">
                      Accept invitation &amp; sign in
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin:0 0 6px;font-size:12px;color:${BRAND_MUTED};">
                If the button doesn't work, copy and paste this link into your browser:
              </p>
              <p style="margin:0 0 28px;font-size:11px;color:${BRAND_BLUE};word-break:break-all;">
                ${acceptUrl}
              </p>

              <!-- Disclosure -->
              <div style="border-top:0.5px solid #E5E7EB;padding-top:20px;">
                <p style="margin:0 0 8px;font-size:12px;font-weight:600;color:${BRAND_NAVY};">
                  Important disclosure
                </p>
                <p style="margin:0;font-size:11px;color:${BRAND_MUTED};line-height:1.7;">
                  By accepting this invitation, you will gain access to the Prism workspace
                  associated with this account. Any data submitted for standardisation on
                  this platform — including raw values, canonical mappings, and run
                  history — may be viewable by other members of this workspace.
                  You should only proceed if you have the authority to share the relevant
                  data with other workspace members and accept this as a condition of use.
                  <strong>Prism and its operators are not liable for any consequences
                  arising from the disclosure, sharing, or standardisation of data on this
                  platform.</strong> If you did not expect this invitation, you may safely
                  disregard this email.
                </p>
              </div>

            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:16px 36px 24px;border-top:0.5px solid #F3F4F6;">
              <p style="margin:0;font-size:11px;color:${BRAND_MUTED};">
                This invitation link expires in 7 days.
                Invited by ${inviterEmail}.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export function buildAcceptUrl(token: string): string {
  return `${getAppUrl()}/accept-invite?token=${encodeURIComponent(token)}`;
}

// Returns the accept URL always. If SMTP isn't configured, logs it to console
// and returns { sent: false, acceptUrl } so the caller can surface it in the UI.
export async function sendInviteEmail(opts: {
  to: string;
  inviterName: string;
  inviterEmail: string;
  token: string;
  invitedRole: 'admin' | 'user';
}): Promise<{ sent: boolean; acceptUrl: string }> {
  const acceptUrl  = buildAcceptUrl(opts.token);
  const roleDesc   = ROLE_DESCRIPTIONS[opts.invitedRole];

  if (!isEmailConfigured()) {
    console.log(
      `\n[Prism] SMTP not configured — invitation link for ${opts.to}:\n  ${acceptUrl}\n`,
    );
    return { sent: false, acceptUrl };
  }

  const transport = getTransport();

  await transport.sendMail({
    from:    getFrom(),
    to:      opts.to,
    subject: `${opts.inviterName || opts.inviterEmail} invited you to Prism as ${roleDesc.label}`,
    html:    inviteHtml(opts.inviterName, opts.inviterEmail, acceptUrl, opts.invitedRole),
    text: [
      `You've been invited to Prism by ${opts.inviterName || opts.inviterEmail} as ${roleDesc.label}.`,
      '',
      `Your role (${roleDesc.label}) permissions:`,
      ...roleDesc.can.map(p => `  ✓ ${p}`),
      ...roleDesc.cannot.map(p => `  ✗ ${p}`),
      '',
      `Accept your invitation: ${acceptUrl}`,
      '',
      'DISCLOSURE: By accepting, you may gain access to data submitted by other workspace members. Prism is not liable for any consequences related to data shared on this platform.',
      '',
      'This link expires in 7 days.',
    ].join('\n'),
  });

  return { sent: true, acceptUrl };
}
