#!/bin/bash

# ============================================================================
# Stand Database - Clean Deployment Script
# ============================================================================
# This script performs a clean deployment of the Stand database with proper
# sequence synchronization to prevent primary key conflicts
# ============================================================================

set -e  # Exit on error

echo "============================================================"
echo "Stand Database - Clean Deployment"
echo "============================================================"
echo ""

# Check if snowsql is available
if ! command -v snowsql &> /dev/null; then
    echo "❌ Error: snowsql command not found!"
    echo "Please install Snowflake CLI tools first."
    exit 1
fi

echo "✓ snowsql found"
echo ""

# Confirm before proceeding
read -p "⚠️  This will DROP and RECREATE the STAND_DB database. Continue? (yes/no): " -r
echo ""
if [[ ! $REPLY =~ ^[Yy][Ee][Ss]$ ]]; then
    echo "Deployment cancelled."
    exit 0
fi

echo "Starting deployment..."
echo ""

# Step 1: Drop existing database (if any)
echo "Step 1: Dropping existing database..."
snowsql -q "DROP DATABASE IF EXISTS STAND_DB;" || {
    echo "❌ Failed to drop database"
    exit 1
}
echo "✓ Database dropped"
echo ""

# Step 2: Bootstrap
echo "Step 2: Running bootstrap..."
snowsql -f 00_bootstrap.sql || {
    echo "❌ Bootstrap failed"
    exit 1
}
echo "✓ Bootstrap complete"
echo ""

# Step 3: Create internal tables and sample data
echo "Step 3: Creating internal tables and sample data..."
snowsql -f 01_internal_tables.sql || {
    echo "❌ Internal tables creation failed"
    exit 1
}
echo "✓ Internal tables created"
echo "✓ Sample data inserted"
echo "✓ Sequences synchronized"
echo ""

# Step 4: Create public API
echo "Step 4: Creating public API procedures..."
snowsql -f 02_public_api.sql || {
    echo "❌ Public API creation failed"
    exit 1
}
echo "✓ Public API created"
echo ""

# Step 5: Grant permissions
echo "Step 5: Setting up grants and permissions..."
snowsql -f 03_grants.sql || {
    echo "❌ Grants setup failed"
    exit 1
}
echo "✓ Grants configured"
echo ""

# Step 6: Verify deployment
echo "Step 6: Verifying deployment..."
snowsql -f verify_sequences.sql -o output_format=tsv -o header=true || {
    echo "⚠️  Verification script encountered issues"
    echo "Please review the output above"
}
echo ""

echo "============================================================"
echo "✓ Deployment Complete!"
echo "============================================================"
echo ""
echo "Next Steps:"
echo ""
echo "1. Review verification results above"
echo "2. Test creating a new run:"
echo "   snowsql -q \"CALL STAND_DB.STAND.CREATE_RUN('mobile_carrier', 'TEST_DB.PUBLIC.RAW_MOBILE_CARRIERS', 'RAW_CARRIER_VALUE', 'review');\""
echo ""
echo "3. Verify run_id = 2 (not 1) is created"
echo ""
echo "4. Start the UI:"
echo "   cd stand-ui"
echo "   npm run dev"
echo ""
echo "5. Access the UI:"
echo "   http://localhost:8000/run/1"
echo ""

