#!/bin/bash

# Stand UI Setup Script
# This script helps set up the Stand UI application

set -e

echo "================================================"
echo "Stand UI Setup Script"
echo "================================================"
echo ""

# Check if we're in the right directory
if [ ! -f "package.json" ]; then
    echo "❌ Error: package.json not found!"
    echo "Please run this script from the stand-ui directory."
    exit 1
fi

echo "✓ Running in stand-ui directory"
echo ""

# Step 1: Check Node.js version
echo "Step 1: Checking Node.js version..."
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
    echo "❌ Error: Node.js version 20 or higher required!"
    echo "Current version: $(node -v)"
    exit 1
fi
echo "✓ Node.js version: $(node -v)"
echo ""

# Step 2: Install dependencies
echo "Step 2: Installing dependencies..."
npm install
echo "✓ Dependencies installed"
echo ""

# Step 3: Check for .env.local
echo "Step 3: Checking environment configuration..."
if [ ! -f ".env.local" ]; then
    echo "⚠️  Warning: .env.local not found!"
    echo ""
    echo "Creating .env.local template..."
    cat > .env.local << EOL
# Snowflake Connection Details
SNOWFLAKE_ACCOUNT=your_account.region
SNOWFLAKE_USER=your_username
SNOWFLAKE_PASSWORD=your_password
SNOWFLAKE_WAREHOUSE=your_warehouse

# If your user requires MFA (TOTP), prefer key-pair auth instead of password:
# SNOWFLAKE_PRIVATE_KEY_PATH=/absolute/path/to/rsa_key.p8
# or inline (escape newlines):
# SNOWFLAKE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
# SNOWFLAKE_PRIVATE_KEY_PASSPHRASE=your_passphrase
EOL
    echo "✓ Created .env.local template"
    echo ""
    echo "⚠️  IMPORTANT: Please edit .env.local with your actual Snowflake credentials!"
    echo ""
    echo "Example values:"
    echo "  SNOWFLAKE_ACCOUNT=abc12345.us-east-1"
    echo "  SNOWFLAKE_USER=SANJIVP2703"
    echo "  SNOWFLAKE_PASSWORD=your_secure_password"
    echo "  SNOWFLAKE_WAREHOUSE=COMPUTE_WH"
    echo ""
else
    echo "✓ .env.local exists"
    echo ""
    echo "Please verify your Snowflake credentials are correct:"
    grep -v "PASSWORD" .env.local || true
    echo "  SNOWFLAKE_PASSWORD=***************"
    echo ""
fi

# Step 4: Verify Snowflake SQL is deployed
echo "Step 4: Snowflake Setup Verification"
echo ""
echo "⚠️  Before starting the UI, ensure you've deployed the SQL files:"
echo ""
echo "  cd .."
echo "  snowsql -f 00_bootstrap.sql"
echo "  snowsql -f 01_internal_tables.sql"
echo "  snowsql -f 02_public_api.sql"
echo "  snowsql -f 03_grants.sql"
echo ""
read -p "Have you deployed the SQL files? (y/n) " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "⚠️  Please deploy the SQL files before continuing."
    echo "Exiting..."
    exit 0
fi

# Step 5: Ready to start
echo ""
echo "================================================"
echo "✓ Setup Complete!"
echo "================================================"
echo ""
echo "To start the development server:"
echo "  npm run dev"
echo ""
echo "The application will be available at:"
echo "  http://localhost:8000"
echo ""
echo "To view a run:"
echo "  http://localhost:8000/run/<run_id>"
echo ""
echo "Example (using sample data):"
echo "  http://localhost:8000/run/1"
echo ""

