#!/usr/bin/env bash
set -euo pipefail

missing=()
[[ -n "${AWS_ACCESS_KEY_ID:-}" ]] || missing+=(S3_ACCESS_KEY_ID)
[[ -n "${AWS_SECRET_ACCESS_KEY:-}" ]] || missing+=(S3_SECRET_ACCESS_KEY)
[[ -n "${AWS_DEFAULT_REGION:-}" ]] || missing+=(S3_REGION)
[[ -n "${S3_BUCKET:-}" ]] || missing+=(S3_BUCKET)
[[ -n "${S3_ENDPOINT:-}" ]] || missing+=(S3_ENDPOINT)
[[ -n "${PLAYWRIGHT_PUBLIC_BASE_URL:-}" ]] || missing+=(PLAYWRIGHT_PUBLIC_BASE_URL)

if (( ${#missing[@]} > 0 )); then
  echo "enabled=false" >> "$GITHUB_OUTPUT"
  if (( ${#missing[@]} == 6 )); then
    echo "::notice::External Playwright report publication is not configured; skipping it."
  else
    echo "::warning::External Playwright report publication skipped; missing repository configuration: ${missing[*]}"
  fi
  {
    echo '### External Playwright report publication skipped'
    echo 'The optional screenshot gallery needs S3 storage configuration. Test results and screenshots remain in the originating CI run artifacts.'
    echo "Missing configuration: ${missing[*]}"
  } >> "$GITHUB_STEP_SUMMARY"
else
  echo "enabled=true" >> "$GITHUB_OUTPUT"
fi
