#!/usr/bin/env bash
# Build + push the native image to the dev account's SPCS image repository
# (Phase N2). Usage:
#   bash native/push.sh <repository_url>
# where <repository_url> comes from:
#   SHOW IMAGE REPOSITORIES IN SCHEMA PRISM_DB.INTERNAL;
# e.g. myorg-myacct.registry.snowflakecomputing.com/prism_db/internal/prism_images
#
# Login first (uses your Snowflake user; docker credential prompt):
#   docker login <registry-host> -u <snowflake-user>
set -euo pipefail

REPO_URL="${1:?usage: bash native/push.sh <repository_url>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# SPCS runs linux/amd64 — build for that platform explicitly (Apple Silicon
# hosts otherwise produce arm64 images the pool cannot run).
docker build --platform linux/amd64 -f "$ROOT/native/Dockerfile" -t prism-native "$ROOT/stand-ui"
docker tag prism-native "$REPO_URL/prism-native:latest"
docker push "$REPO_URL/prism-native:latest"

echo
echo "Pushed $REPO_URL/prism-native:latest"
echo "If the service is already running: ALTER SERVICE PRISM_DB.INTERNAL.PRISM_APP FROM @PRISM_DB.INTERNAL.NATIVE_ARTIFACTS SPECIFICATION_FILE='service-spec.yaml';"
