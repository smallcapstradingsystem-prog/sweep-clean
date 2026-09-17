#!/usr/bin/env bash
# verify.sh — Check that a deployed bundle matches the published release.
#
# USAGE
#   ./verify.sh https://sweep.yourdomain.com

set -e

DOMAIN="${1:?Usage: ./verify.sh https://yourdomain.com}"

echo "Fetching release metadata..."
META=$(curl -s "${DOMAIN}/releases/latest.txt")
echo "$META"
echo

EXPECTED=$(echo "$META" | awk '/^sha256_hex:/ {print $2}')
if [ -z "$EXPECTED" ]; then
  echo "ERROR: could not parse sha256_hex from metadata"
  exit 1
fi

echo "Fetching app.js..."
ACTUAL=$(curl -s "${DOMAIN}/app.js" | openssl dgst -sha256 -r | awk '{print $1}')

echo "Expected: $EXPECTED"
echo "Actual:   $ACTUAL"

if [ "$EXPECTED" = "$ACTUAL" ]; then
  echo "✓ MATCH — bundle is authentic"
  exit 0
else
  echo "✗ MISMATCH — do not trust this deployment"
  exit 1
fi