// PLACEHOLDER LEGAL TEXT — have counsel review/replace before selling. Generated 2026-07-02.

import { getWarehouseAdapter } from '@/app/api/_lib/warehouse';
import { isNativeEdition } from '@/app/api/_lib/edition';

/**
 * The warehouse this installation is actually configured for.
 *
 * The page hardcoded "Snowflake" in four places — including the subprocessor
 * list and the credential-security section — so a SQL Server customer read a
 * privacy policy naming a vendor they have no relationship with, and listing a
 * subprocessor that never touches their data. That is a worse failure on a
 * legal page than on a settings screen (SEC-07). The sibling
 * ExportTableDisclosure was parameterised the same way earlier today.
 *
 * Falls back to neutral wording rather than throwing: this page is PUBLIC
 * (linked from login), so it has to render even if the workspace config cannot
 * be read.
 */
function warehouseName(): string {
  try {
    const kind = getWarehouseAdapter().kind;
    return kind === 'mssql' ? 'SQL Server' : kind === 'postgres' ? 'PostgreSQL' : kind === 'mysql' ? 'MySQL' : 'Snowflake';
  } catch {
    return 'your data warehouse';
  }
}

export const metadata = {
  title: 'Privacy policy — Prism',
};

const sectionTitle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
  color: 'var(--text-primary)',
  marginTop: 32,
  marginBottom: 10,
};

const bodyText: React.CSSProperties = {
  fontSize: 14,
  lineHeight: 1.7,
  color: 'var(--text-secondary)',
  marginBottom: 12,
};

const listStyle: React.CSSProperties = {
  ...bodyText,
  paddingLeft: 22,
  listStyleType: 'disc',
};

export default function PrivacyPage() {
  const warehouse = warehouseName();
  const native = isNativeEdition();
  return (
    <div style={{ backgroundColor: 'var(--page-bg)', minHeight: '100vh', padding: '48px 24px' }}>
      <div style={{ maxWidth: 720, margin: '0 auto' }}>

        {/* Brand */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 28 }}>
          <svg width="34" height="26" viewBox="0 0 44 34" fill="none" aria-hidden="true">
            <polygon points="0,0 0,34 22,17" fill="#1A1A2E" />
            <polygon points="44,0 44,34 22,17" fill="#378ADD" />
            <circle cx="22" cy="17" r="2.2" fill="white" />
          </svg>
          <span style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--text-primary)' }}>
            Prism
          </span>
        </div>

        <div
          style={{
            backgroundColor: 'var(--surface)',
            border: '0.5px solid var(--border)',
            borderRadius: 'var(--radius-card)',
            padding: '40px 44px',
          }}
        >
          <h1 style={{ fontSize: 22, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>
            Privacy policy
          </h1>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 24 }}>
            Last updated: July 2, 2026
          </p>

          <p style={bodyText}>
            This privacy policy explains what information Prism collects, how it is used, and the
            choices you have. Prism is a data standardization platform that {native
            ? 'runs inside your Snowflake account and connects to the tables your administrator grants it'
            : <>connects to data sources you designate — your {warehouse} data warehouse and Google Sheets</>} — and helps
            you map inconsistent text values to canonical names. It applies alongside our{' '}
            <a href="/terms" style={{ color: 'var(--accent)', textDecoration: 'none' }}>terms of service</a>.
          </p>

          <h2 style={sectionTitle}>1. Data we collect</h2>
          <ul style={listStyle}>
            {native ? (
              <li>
                <strong>Account information</strong> — your Snowflake username (provided by
                Snowflake when you open the app) and your workspace role. No credentials are
                collected: authentication is handled entirely by Snowflake.
              </li>
            ) : (
              <>
                <li>
                  <strong>Account information</strong> — your name, email address, and profile picture
                  from Google sign-in, plus your workspace role and invitation history.
                </li>
                <li>
                  <strong>Connection credentials</strong> — {warehouse} credentials (password or private
                  key) and Google OAuth tokens (including refresh tokens for connected Sheets
                  pipelines) that you provide to connect your data sources.
                </li>
              </>
            )}
            <li>
              <strong>Customer data values</strong> — the distinct text values from the columns
              and sheets you choose to standardize, and the confirmed mappings between raw values
              and canonical names.
            </li>
            <li>
              <strong>Operational data</strong> — run history, pipeline configuration, review
              decisions, and audit logs generated by your use of the Service.
            </li>
          </ul>

          <h2 style={sectionTitle}>2. How we use it</h2>
          <ul style={listStyle}>
            <li>To authenticate you and manage workspace access and invitations;</li>
            <li>To connect to and read from the data sources you configure;</li>
            <li>
              {native
                ? 'To propose groupings and canonical names for your data values, using Snowflake Cortex AI models running inside your Snowflake account (values are not sent to us or to any external AI provider);'
                : 'To propose groupings and canonical names for your data values, including by sending those values to our language model provider for classification;'}
            </li>
            <li>To store confirmed mappings and write standardized output where you direct it;</li>
            <li>To operate, secure, troubleshoot, and improve the Service.</li>
          </ul>
          <p style={bodyText}>
            We do not sell your data, and we do not use your Customer Data to build products for
            other customers.
          </p>

          <h2 style={sectionTitle}>3. Subprocessors</h2>
          <ul style={listStyle}>
            {native ? (
              <li>
                <strong>Snowflake</strong> — hosts the application, stores all data, and provides
                the AI models (Snowflake Cortex) used for classification, all inside your
                Snowflake account under your agreement with Snowflake. No other party receives
                your data.
              </li>
            ) : (
              <>
                <li>
                  <strong>{warehouse}</strong> — mappings, run state, and pipeline configuration are
                  stored in your connected {warehouse} account, under your agreement with {warehouse}.
                </li>
                <li>
                  <strong>AI provider (Anthropic by default; OpenAI or Google if your
                  workspace configures one)</strong> — distinct data values (never your credentials) are
                  sent to the configured provider&rsquo;s API to propose groupings and canonical names.
                </li>
                <li>
                  <strong>Google</strong> — used for sign-in and, when you connect them, for reading
                  and writing the Google Sheets you authorize.
                </li>
              </>
            )}
          </ul>

          <h2 style={sectionTitle}>4. Retention</h2>
          <p style={bodyText}>
            Confirmed mappings, run history, and pipeline configuration are retained for as long
            as your workspace remains active, since accumulated mappings are the core value of
            the Service. {native ? '' : <>Stored credentials are retained until you replace or remove them, or
            until the associated connection is deleted. </>}Account information is retained while your
            account exists and is removed when a user is removed from the workspace, except where
            retention is required for audit or legal purposes.
          </p>

          <h2 style={sectionTitle}>5. Security measures</h2>
          <ul style={listStyle}>
            <li>
              Stored credentials — {warehouse} passwords, private keys, and Google refresh tokens —
              are encrypted at rest at the application level using AES-256-GCM, in addition to the
              storage-layer encryption provided by the underlying platform.
            </li>
            <li>All data in transit is protected with TLS.</li>
            <li>
              Sessions use signed, HTTP-only cookies; removing a user invalidates their active
              sessions immediately.
            </li>
            <li>
              Access to workspace data requires a valid invitation from a workspace administrator.
            </li>
          </ul>
          <p style={bodyText}>
            No method of transmission or storage is completely secure, but we work to protect
            your information using industry-standard practices.
          </p>

          <h2 style={sectionTitle}>6. Your rights</h2>
          <p style={bodyText}>
            Depending on your jurisdiction, you may have the right to access, correct, export, or
            delete personal information we hold about you, and to object to or restrict certain
            processing. Workspace administrators can remove users and delete pipelines and
            connections directly in the Service. For other requests, contact us using the details
            below and we will respond within a reasonable timeframe.
          </p>

          <h2 style={sectionTitle}>7. Changes to this policy</h2>
          <p style={bodyText}>
            We may update this policy from time to time. Material changes will be reflected in the
            &ldquo;last updated&rdquo; date above and, where appropriate, notified within the Service.
          </p>

          <h2 style={sectionTitle}>8. Contact</h2>
          <p style={bodyText}>
            Questions about this policy or your data can be sent to{' '}
            <a href="mailto:sanjivp2703@gmail.com" style={{ color: 'var(--accent)', textDecoration: 'none' }}>
              sanjivp2703@gmail.com
            </a>.
          </p>
        </div>

        {/* Footer nav */}
        <div style={{ display: 'flex', gap: 20, marginTop: 20, fontSize: 13 }}>
          <a href="/terms" style={{ color: 'var(--accent)', textDecoration: 'none', fontWeight: 500 }}>
            Terms of service
          </a>
          <a href="/login" style={{ color: 'var(--text-muted)', textDecoration: 'none' }}>
            Back to sign in
          </a>
        </div>
      </div>
    </div>
  );
}
