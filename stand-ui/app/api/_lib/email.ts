import 'server-only';
import nodemailer from 'nodemailer';

/** HTTPS email API (Resend). Preferred over SMTP because many hosts block
 *  outbound SMTP entirely — DigitalOcean blocks 25/465/587 on new accounts,
 *  which made invitation email impossible on a standard droplet deploy
 *  (live-verified 2026-08-19). Nothing here needs a mail port. */
function getResendKey(): string | undefined {
  return process.env.RESEND_API_KEY?.trim() || undefined;
}

export function isEmailConfigured(): boolean {
  return !!(getResendKey() || (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS));
}

/** Sends via Resend's HTTP API. Throws on a non-2xx so the caller's
 *  degrade-to-link path handles it exactly like an SMTP failure. */
async function sendViaResend(args: {
  apiKey: string; from: string; to: string; subject: string; html: string; text: string;
}): Promise<void> {
  const res = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: { Authorization: `Bearer ${args.apiKey}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      from: args.from, to: [args.to], subject: args.subject, html: args.html, text: args.text,
    }),
    // Same fail-fast posture as the SMTP transport.
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    // Resend returns a JSON body explaining the refusal (unverified domain,
    // bad key, rate limit) — surface it, since those are exactly the setup
    // mistakes an operator needs to see.
    const detail = await res.text().catch(() => '');
    throw new Error(`Resend API ${res.status}: ${detail.slice(0, 300)}`);
  }
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
    // Fail fast. Outbound SMTP is blocked by default on many hosts
    // (DigitalOcean does it on new accounts) and nodemailer's default
    // timeouts leave the invite request hanging for minutes before the
    // caller can fall back to showing the link.
    connectionTimeout: 10_000,
    greetingTimeout:   10_000,
    socketTimeout:     20_000,
  });
}

function getFrom() {
  // EMAIL_FROM is the provider-neutral name; SMTP_FROM stays supported so
  // existing installs keep working. With Resend this address must be on a
  // domain verified in the Resend dashboard.
  return process.env.EMAIL_FROM || process.env.SMTP_FROM || process.env.SMTP_USER || 'Prism <noreply@prism.app>';
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
    can:    ['View and standardize data', 'Create and review runs', 'Export canonical mappings', 'Invite new users (admin or user)', 'Remove existing accounts'],
    cannot: [],
  },
  user: {
    label:  'User',
    can:    ['View and standardize data', 'Create and review runs', 'Export canonical mappings'],
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
                standardization platform for unifying inconsistent categorical values across
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
                  associated with this account. Any data submitted for standardization on
                  this platform — including raw values, canonical mappings, and run
                  history — may be viewable by other members of this workspace.
                  You should only proceed if you have the authority to share the relevant
                  data with other workspace members and accept this as a condition of use.
                  <strong>Prism and its operators are not liable for any consequences
                  arising from the disclosure, sharing, or standardization of data on this
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
/** Plain-text alternative — identical wording to the SMTP path's inline
 *  version, extracted so both transports send the same body. */
function inviteText(
  inviterName: string | undefined,
  inviterEmail: string,
  acceptUrl: string,
  invitedRole: 'user' | 'admin',
): string {
  const roleDesc = ROLE_DESCRIPTIONS[invitedRole];
  return [
    `You've been invited to Prism by ${inviterName || inviterEmail} as ${roleDesc.label}.`,
    '',
    `Your role (${roleDesc.label}) permissions:`,
    ...roleDesc.can.map(pp => `  \u2713 ${pp}`),
    ...roleDesc.cannot.map(pp => `  \u2717 ${pp}`),
    '',
    `Accept your invitation: ${acceptUrl}`,
    '',
    'DISCLOSURE: By accepting, you may gain access to data submitted by other workspace members. Prism is not liable for any consequences related to data shared on this platform.',
    '',
    'This link expires in 7 days.',
  ].join('\n');
}

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

  // A send FAILURE degrades exactly like "not configured" (finding #23):
  // the invitation itself is already valid, so the caller must be able to
  // show the link rather than report a failure that didn't happen. Only the
  // delivery failed, and that is what `sent: false` means.
  const subject   = `${opts.inviterName || opts.inviterEmail} invited you to Prism as ${roleDesc.label}`;
  const html      = inviteHtml(opts.inviterName, opts.inviterEmail, acceptUrl, opts.invitedRole);
  const text      = inviteText(opts.inviterName, opts.inviterEmail, acceptUrl, opts.invitedRole);
  const resendKey = getResendKey();

  try {
    if (resendKey) {
      await sendViaResend({ apiKey: resendKey, from: getFrom(), to: opts.to, subject, html, text });
    } else {
      await getTransport().sendMail({ from: getFrom(), to: opts.to, subject, html, text });
    }
  } catch (err) {
    console.error(
      `[Prism] Invitation email to ${opts.to} could not be sent (the invitation is still valid — ` +
      `share the link manually):`,
      (err as { message?: string })?.message ?? err,
    );
    return { sent: false, acceptUrl };
  }

  return { sent: true, acceptUrl };
}
