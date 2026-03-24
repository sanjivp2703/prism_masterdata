# Environment Variables

Create a `.env.local` file in the root of the `stand-ui` directory with the following variables:

```bash
SNOWFLAKE_ACCOUNT=your_account.region
SNOWFLAKE_USER=your_username
SNOWFLAKE_PASSWORD=your_password
SNOWFLAKE_WAREHOUSE=your_warehouse
```

## MFA (TOTP) accounts
If your Snowflake user requires MFA, password auth will fail for these server-side API calls.

Recommended: use key-pair auth:

```bash
SNOWFLAKE_PRIVATE_KEY_PATH=/absolute/path/to/rsa_key.p8
# or inline (escape newlines):
SNOWFLAKE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
SNOWFLAKE_PRIVATE_KEY_PASSPHRASE=your_passphrase   # optional
```

## Example

```bash
SNOWFLAKE_ACCOUNT=abc12345.us-east-1
SNOWFLAKE_USER=SANJIVP2703
SNOWFLAKE_PASSWORD=your_secure_password
SNOWFLAKE_WAREHOUSE=COMPUTE_WH
```

