# Stand UI - Setup and Usage Guide

## Overview

This Next.js application provides a web interface for viewing data standardization run details, including the mapping of standardized aliases to their raw value variants.

## Prerequisites

- Node.js 20+ 
- Access to a Snowflake account with the Stand database configured
- Snowflake credentials with at least `STAND_USER` role access

## Setup Instructions

### 1. Install Dependencies

```bash
cd stand-ui
npm install
```

### 2. Configure Snowflake Connection

Create a `.env.local` file in the `stand-ui` directory:

```bash
SNOWFLAKE_ACCOUNT=your_account.region
SNOWFLAKE_USER=your_username
SNOWFLAKE_PASSWORD=your_password
SNOWFLAKE_WAREHOUSE=your_warehouse
```

**Example:**
```bash
SNOWFLAKE_ACCOUNT=abc12345.us-east-1
SNOWFLAKE_USER=SANJIVP2703
SNOWFLAKE_PASSWORD=your_secure_password
SNOWFLAKE_WAREHOUSE=COMPUTE_WH
```

#### If your Snowflake user requires MFA (TOTP)
The UI makes server-side API calls to Snowflake; **password + interactive MFA won’t work**.

Recommended options:

- **Key-pair auth (recommended)**:

```bash
# Use ONE of the following:
SNOWFLAKE_PRIVATE_KEY_PATH=/absolute/path/to/rsa_key.p8
# or inline (escape newlines):
SNOWFLAKE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"

# If encrypted:
SNOWFLAKE_PRIVATE_KEY_PASSPHRASE=your_passphrase
```

- **Use a Snowflake user exempt from MFA for API access** (service account), if your org allows it.

### 3. Deploy SQL Procedures

Before running the UI, ensure the SQL procedures are deployed to Snowflake:

```bash
# From the project root
snowsql -f 00_bootstrap.sql
snowsql -f 01_internal_tables.sql
snowsql -f 02_public_api.sql
snowsql -f 03_grants.sql
```

### 4. Start the Development Server

```bash
npm run dev
```

The application will be available at `http://localhost:8000`

## Features

### Run Details Page

Access a specific run at: `http://localhost:8000/run/<run_id>`

The run review interface will allow you to:

1. **Review Groups**: View and edit groups of similar values
2. **Manage Aliases**: Assign or modify alias names for each group
3. **Approve Changes**: Review and approve standardization decisions

### Data Flow

The new grouping system uses:

1. **RUN_GROUPS**: Stores groups with their alias names (user-editable)
2. **RUN_ITEMS**: Individual raw values assigned to groups via `group_id`
3. **CLASSIFICATION_METADATA_PROFILES**: Ordered pipelines for generating classification metadata (per-concept)
4. **ALIASES**: Master list of standardized alias names

Each run creates groups that organize similar raw values together. Users can review, rename groups, merge groups, and approve changes before applying them.

## Database Schema Integration

The UI interacts with these Snowflake objects:

- **Tables**: 
  - `STAND_DB.STAND_INTERNAL.RUNS`
  - `STAND_DB.STAND_INTERNAL.RUN_GROUPS`
  - `STAND_DB.STAND_INTERNAL.RUN_ITEMS`
  - `STAND_DB.STAND_INTERNAL.CLASSIFICATION_METADATA_PROFILES`
  - `STAND_DB.STAND_INTERNAL.ALIASES`

## Troubleshooting

### "Run not found" error
- Verify the run_id exists in the database
- Check your Snowflake user has access to the STAND schema

### Connection errors
- Verify your `.env.local` credentials are correct
- Ensure your Snowflake warehouse is running
- Check network connectivity to Snowflake

### No data displayed
- Ensure the run has been executed and has run_groups and run_items
- Verify the run_groups have proper alias_name values set
- Check that run_items are properly linked to run_groups via group_id

## Development

### File Structure

```
stand-ui/
├── app/
│   ├── run/
│   │   └── [run_id]/
│   │       └── page.tsx               # Run details page UI
│   ├── layout.tsx
│   └── page.tsx
├── package.json
├── ENV_SETUP.md
└── README.md
```

### Adding New Features

To add new run-related endpoints:

1. Create SQL procedure in `02_public_api.sql`
2. Deploy to Snowflake
3. Create API route in `app/api/run/[run_id]/`
4. Update the UI component in `app/run/[run_id]/page.tsx`

## Production Deployment

For production:

1. Set environment variables in your hosting platform
2. Update the API base URL if not using localhost
3. Consider adding authentication/authorization
4. Enable HTTPS for secure credential transmission
5. Use Snowflake key pair authentication instead of password

## Support

For issues or questions, refer to the main project documentation.
