# Prism — Security Brief for Customers

**Purpose.** A plain-language answer to the three questions every customer and
security reviewer asks: *What can Prism see? What can it do? What are we taking
on by running it?*

Written to be shared or read aloud. It is deliberately honest about
limitations — a reviewer who finds something you didn't mention trusts nothing
else you said.

**Audience note.** This is the customer-facing document. The internal
engineering review lives in `SECURITY_AND_DISCLOSURES.md` and goes deeper into
code paths; keep the two in step when access changes.

Last reviewed: 2026-08-06.

---

## 1. The shape of the thing, in one paragraph

Prism installs **inside your infrastructure**, connected to **your** data
warehouse (Snowflake or Microsoft SQL Server). Your data stays in your
warehouse. Prism is one small web application plus a background worker; it
holds almost no data of its own. The only data that ever leaves your network is
the short text values being standardized, sent to an AI provider — covered in
section 4.

There is no Prism cloud service. We cannot see your data, and there is no
central system to breach.

---

## 2. What Prism can access in your warehouse

Prism connects using a dedicated login you create — never a person's account.

### What it can READ

| It can read | Why |
|---|---|
| The source tables you explicitly point it at | To find the values that need standardizing |
| Its own database (`PRISM_DB`) | Where it stores confirmed mappings and its working state |

It cannot read anything else in your warehouse. Access is granted per
schema during setup, by you, one at a time.

### What it can WRITE

| It can write | Where |
|---|---|
| Confirmed mappings and working state | Its own `PRISM_DB` only |
| The standardized output table | The one schema you nominate for output |

### What it deliberately CANNOT do

- **It cannot modify your source tables.** Setup grants read-only access to
  them. There is one exception, covered in section 3.
- **It cannot create logins, roles, or grant anyone else access.**
- **It cannot reach databases you have not named.**

---

## 3. The two capabilities worth discussing explicitly

Most of Prism is unremarkable read-only access. Two things deserve a real
conversation, because both mean Prism writing somewhere that matters.

### 3a. "Column" output mode — Prism writes to your source table

Prism can add a companion column to your existing table
(`CARRIER` → `CARRIER_STANDARDIZED`) instead of building a separate output
table. Some teams strongly prefer this: the clean value sits next to the messy
one, and nothing downstream has to change.

**What it means:** Prism gets permission to modify that one table.

**How it is contained:**

- It is **off by default** and must be chosen per pipeline.
- Choosing it requires an explicit, unmissable consent checkbox in the UI.
- Permission is granted **one table at a time**, at the moment you consent —
  onboarding grants no write access to any source table.
- Code-level guardrails restrict writes to a column named exactly
  `<your column>_STANDARDIZED`, and refuse to run if that name collides with a
  real column of yours. These are enforced in code and covered by automated
  tests.

**Honest statement:** this is the single most invasive thing Prism can do. If
your policy is that no vendor tool writes to production tables, use one of the
other three output modes — you lose nothing but the convenience.

### 3b. Ownership of the output schema (SQL Server only)

On SQL Server, Prism asks to **own the one schema where it writes standardized
tables**.

**Why:** Prism rebuilds the output table on each refresh. SQL Server has no way
to carry a table's access permissions across a rebuild (Snowflake does — this is
a genuine difference between the two platforms). So Prism has to record who had
access and re-grant it afterwards, and SQL Server only lets the *owner* of a
schema read the access list and hand access back out.

**What it grants:** full control of that **one schema** — creating, replacing
and granting access to tables inside it. **No** additional rights over your
source tables, other schemas, other databases, or the server.

**If you decline:** Prism still works, but every refresh silently drops the
permissions on the output table — anyone you had granted access to loses it.
Prism now detects this and warns you on the pipeline rather than failing
quietly, but the permissions still will not survive. Recommended practice is a
schema used *only* for Prism's output.

---

## 4. What leaves your network

Two destinations, and nothing else.

### 4a. Your AI provider

To group messy values, Prism sends **the distinct text values themselves** to
the AI provider you configure — Anthropic (Claude), OpenAI, or Google (Gemini).

**What is sent:** the distinct values from the standardized column (e.g.
`"AT&T"`, `"att"`, `"a t and t"`), the column's name and description, and any
naming rules you wrote.

**What is NOT sent:** whole rows, other columns, row counts, customer
identifiers, or anything from tables you have not pointed Prism at.

**Volume control:** each distinct value is sent **once**. Once a mapping is
confirmed it is stored in your warehouse and reused forever — the same value is
never sent again.

You choose the provider and supply the key, so the commercial and data-handling
terms are between you and them. If your data cannot leave your network at all,
Prism is not suitable in its current form — that is a straight answer, not a
negotiation.

### 4b. Google Sheets (only if you use it)

A Google Sheet can be the source for a one-time standardization ("clean this
list once"). Prism reads that sheet once, when you start the session, and — if
you choose the Sheets output — writes the result to a new spreadsheet in your
Drive; it does not keep re-reading the sheet afterwards, and ongoing pipelines
run on warehouse tables only. All of this uses access you grant through
Google's normal consent screen, requested only when you first use a Sheet
(signing in asks for your identity only). It requests access only to files it
is pointed at or creates. Not used at all if you only connect warehouse tables.

**Every outbound destination, exhaustively:** your AI provider's API, Google's
APIs (only for Sheets), and optionally an error-monitoring service if you
configure one. Nothing else.

---

## 5. Where secrets are kept

| Secret | Stored | Protection |
|---|---|---|
| Warehouse login | Prism's local database | Encrypted (AES-256-GCM) |
| AI provider key | Prism's local database | Encrypted (AES-256-GCM) |
| Google access token | Prism's local database | Encrypted (AES-256-GCM) |
| User sign-in | Browser cookie | Signed, HTTP-only, expires in 7 days |

The encryption key lives in the installation's environment, never in the
database — so a copy of the database alone does not yield the secrets.

Sign-in is Google only; Prism never handles a password. An administrator can
revoke someone's access instantly, which invalidates their active sessions
immediately rather than at next login.

---

## 6. Risks we would raise ourselves

Stated plainly, because a reviewer will find them anyway.

**Values are sent to a third-party AI provider.** The core of section 4. For
some organizations this alone decides it.

**Prism runs as a single application.** It is not clustered. If the machine
goes down, standardization pauses until it returns. Your warehouse and your
data are unaffected — Prism holds no data of its own that matters.

**One installation serves one customer.** There is no multi-tenant separation
inside Prism, because there is no multi-tenancy — your installation is yours
alone. The flip side is that everyone in your installation can see everything in
it; there is no per-user data restriction today.

**Anyone in your installation can create a pipeline.** Access is by
invitation, and administrators control who is invited, but there is no
finer-grained permission model within the app yet.

**Column mode writes to your table.** Section 3a, restated here so it appears in
the risk list rather than only in the capability list.

---

## 7. Questions worth asking us

If you are evaluating Prism, these are the ones we would ask in your position —
and we will answer all of them directly:

- Which of the four output modes do you recommend for us, and why?
- What exactly will be sent to the AI provider from *our* columns?
- Can we see the precise permission statements before running them?
  *(Yes — setup shows every statement for your administrator to review and run.
  Prism never runs them with elevated privileges itself.)*
- What happens if the AI provider is unavailable? *(Standardization pauses and
  retries; nothing is lost or half-written.)*
- Can we remove Prism cleanly? *(Yes — drop its database and revoke the login.
  Materialized output tables remain and keep working. Note that if you chose
  live-view output, those views stop working once Prism's database is gone.)*
