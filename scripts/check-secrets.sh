#!/usr/bin/env bash
set -euo pipefail

# Scans all files that git tracks or would track (excluding gitignored files)
# for Stripe secret/restricted/publishable/webhook keys and real-looking Stripe object IDs.

KEY_PATTERN='(sk_live_|sk_test_|rk_live_|rk_test_|pk_live_|pk_test_|whsec_)[A-Za-z0-9]{20,}'
ID_PATTERN='(acct_|prod_|price_|sub_|cs_test_|cs_live_)[A-Za-z0-9]{10,}'
COMBINED_PATTERN="${KEY_PATTERN}|${ID_PATTERN}"

found=0

while IFS= read -r -d '' file; do
  [ -f "$file" ] || continue
  if matches=$(grep -InE "$COMBINED_PATTERN" "$file" 2>/dev/null); then
    echo "ERROR: Potential Stripe secret or resource ID detected in $file:"
    echo "$matches"
    found=1
  fi
done < <(git ls-files -z -co --exclude-standard)

if [ "$found" -ne 0 ]; then
  echo "Secret check FAILED: remove or replace real keys/IDs with placeholders before committing." >&2
  exit 1
fi

echo "Secret check PASSED: no Stripe keys or real-looking resource IDs found in tracked files."
exit 0
