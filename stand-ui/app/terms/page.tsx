// PLACEHOLDER LEGAL TEXT — have counsel review/replace before selling. Generated 2026-07-02.

export const metadata = {
  title: 'Terms of service — Prism',
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

export default function TermsPage() {
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
            Terms of service
          </h1>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 24 }}>
            Last updated: July 2, 2026
          </p>

          <p style={bodyText}>
            These terms of service (&ldquo;Terms&rdquo;) govern your access to and use of Prism, a data
            standardization platform that maps inconsistent text values in your data to canonical
            names (the &ldquo;Service&rdquo;). Please read these Terms carefully before using the Service.
          </p>

          <h2 style={sectionTitle}>1. Acceptance of terms</h2>
          <p style={bodyText}>
            By creating an account, accepting a workspace invitation, or otherwise accessing or
            using the Service, you agree to be bound by these Terms and our{' '}
            <a href="/privacy" style={{ color: 'var(--accent)', textDecoration: 'none' }}>privacy policy</a>.
            If you are using the Service on behalf of an organization, you represent that you have
            authority to bind that organization, and &ldquo;you&rdquo; refers to that organization. If you do
            not agree to these Terms, do not use the Service.
          </p>

          <h2 style={sectionTitle}>2. Description of the service</h2>
          <p style={bodyText}>
            Prism connects to data sources you designate — including your Snowflake data warehouse
            and Google Sheets — using credentials you provide, and helps you standardize
            inconsistent text values into canonical names. Confirmed mappings are stored in a
            lookup table within your connected Snowflake environment and, depending on your
            configuration, may be written back to export tables or spreadsheets you control. The
            Service uses a third-party large language model provider (Anthropic) to propose
            groupings and canonical names for the data values you submit for standardization.
          </p>

          <h2 style={sectionTitle}>3. Customer data and credentials</h2>
          <p style={bodyText}>
            You retain all right, title, and interest in the data you connect to or process
            through the Service (&ldquo;Customer Data&rdquo;). You grant us a limited license to access,
            process, and store Customer Data solely to provide and improve the Service for you.
          </p>
          <ul style={listStyle}>
            <li>
              You are responsible for the credentials you provide (Snowflake credentials, Google
              account authorization) and for ensuring you are authorized to connect the data
              sources you configure.
            </li>
            <li>
              Stored credentials are encrypted at rest by the application. Data values sent for
              classification are transmitted to our subprocessors as described below; your
              credentials are never sent to the language model provider.
            </li>
            <li>
              You are responsible for the accuracy and lawfulness of Customer Data, including
              ensuring it does not contain data you are not permitted to process.
            </li>
          </ul>

          <h2 style={sectionTitle}>4. Subprocessors</h2>
          <p style={bodyText}>
            We use the following third-party subprocessors to provide the Service:
          </p>
          <ul style={listStyle}>
            <li>
              <strong>Snowflake</strong> — your connected warehouse stores mappings, run state, and
              pipeline configuration. Data resides in your Snowflake account, under your
              agreement with Snowflake.
            </li>
            <li>
              <strong>Anthropic</strong> — distinct data values (not credentials, and not full
              source rows beyond the values being standardized) are sent to Anthropic&rsquo;s API to
              propose groupings and canonical names.
            </li>
            <li>
              <strong>Google</strong> — used for sign-in (OAuth) and, when you connect them, for
              reading and writing Google Sheets you authorize.
            </li>
          </ul>
          <p style={bodyText}>
            We may update this list from time to time; material changes will be reflected in these
            Terms or the privacy policy.
          </p>

          <h2 style={sectionTitle}>5. Acceptable use</h2>
          <p style={bodyText}>You agree not to:</p>
          <ul style={listStyle}>
            <li>Use the Service in violation of applicable law or third-party rights;</li>
            <li>Connect data sources or provide credentials you are not authorized to use;</li>
            <li>Attempt to probe, disrupt, or gain unauthorized access to the Service or its infrastructure;</li>
            <li>Reverse engineer, resell, or sublicense the Service except as permitted in writing;</li>
            <li>Use the Service to process data prohibited by our subprocessors&rsquo; terms.</li>
          </ul>

          <h2 style={sectionTitle}>6. Availability disclaimer</h2>
          <p style={bodyText}>
            The Service is provided on an &ldquo;as is&rdquo; and &ldquo;as available&rdquo; basis. We do not warrant that
            the Service will be uninterrupted, error-free, or that proposed standardizations will
            be accurate or complete. Automated groupings are proposals — you are responsible for
            reviewing and confirming mappings before relying on them. We may modify, suspend, or
            discontinue features at any time.
          </p>

          <h2 style={sectionTitle}>7. Limitation of liability</h2>
          <p style={bodyText}>
            To the maximum extent permitted by law, in no event will we be liable for any
            indirect, incidental, special, consequential, or punitive damages, or any loss of
            profits, revenue, data, or business opportunities, arising out of or related to these
            Terms or the Service, regardless of the theory of liability. Our aggregate liability
            under these Terms will not exceed the amounts you paid for the Service in the twelve
            months preceding the event giving rise to the claim.
          </p>

          <h2 style={sectionTitle}>8. Termination</h2>
          <p style={bodyText}>
            You may stop using the Service at any time. We may suspend or terminate your access if
            you materially breach these Terms and do not cure the breach within a reasonable
            period after notice, or immediately for serious violations. Upon termination, your
            right to use the Service ends; mappings and export tables stored in your own Snowflake
            account or spreadsheets remain under your control. Sections that by their nature
            should survive termination (including ownership, limitation of liability, and
            governing terms) will survive.
          </p>

          <h2 style={sectionTitle}>9. Changes to these terms</h2>
          <p style={bodyText}>
            We may update these Terms from time to time. If we make material changes, we will
            provide reasonable notice, such as by updating the &ldquo;last updated&rdquo; date above or
            notifying you within the Service. Continued use of the Service after changes take
            effect constitutes acceptance of the revised Terms.
          </p>

          <h2 style={sectionTitle}>10. Contact</h2>
          <p style={bodyText}>
            Questions about these Terms can be sent to{' '}
            <a href="mailto:legal@prism.example.com" style={{ color: 'var(--accent)', textDecoration: 'none' }}>
              legal@prism.example.com
            </a>.
          </p>
        </div>

        {/* Footer nav */}
        <div style={{ display: 'flex', gap: 20, marginTop: 20, fontSize: 13 }}>
          <a href="/privacy" style={{ color: 'var(--accent)', textDecoration: 'none', fontWeight: 500 }}>
            Privacy policy
          </a>
          <a href="/login" style={{ color: 'var(--text-muted)', textDecoration: 'none' }}>
            Back to sign in
          </a>
        </div>
      </div>
    </div>
  );
}
