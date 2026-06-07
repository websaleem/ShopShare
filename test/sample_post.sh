#!/usr/bin/env bash
# Usage: ./sample_post.sh <API_URL> <IMAGE_PATH> [JWT]
# Example: ./sample_post.sh https://dev.example.com/shopshare/api/extract ./receipt.jpg "eyJhbGci..."

set -euo pipefail
API_URL=${1:-}
IMAGE_PATH=${2:-}
JWT=${3:-}

if [[ -z "$API_URL" || -z "$IMAGE_PATH" ]]; then
  echo "Usage: $0 <API_URL> <IMAGE_PATH> [JWT]"
  exit 1
fi

if [[ ! -f "$IMAGE_PATH" ]]; then
  echo "Image file not found: $IMAGE_PATH"
  exit 1
fi

# Read and base64-encode (no line wraps)
DATA_B64=$(openssl base64 -A -in "$IMAGE_PATH")
MIME_TYPE=$(file --brief --mime-type -- "$IMAGE_PATH")

BODY=$(jq -n --arg mime "$MIME_TYPE" --arg b64 "$DATA_B64" '{mime_type: $mime, data_b64: $b64}')

if [[ -n "$JWT" ]]; then
  AUTH_HDR=( -H "Authorization: Bearer $JWT" )
else
  AUTH_HDR=()
fi

echo "Posting to $API_URL (mime: $MIME_TYPE)"
curl -sS -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  "${AUTH_HDR[@]}" \
  -d "$BODY" | jq
