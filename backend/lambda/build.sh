#!/usr/bin/env bash
# Builds lambda.zip for the shopshare-extract function.
# Run from inside aws/lambda/.
#
# Lambda runtime: python3.12, x86_64.
# If you create the function on arm64, change --platform to manylinux2014_aarch64.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BUILD="$HERE/build"
OUT="$HERE/lambda.zip"

rm -rf "$BUILD" "$OUT"
mkdir -p "$BUILD"

python3 -m pip install \
    --target "$BUILD" \
    --platform manylinux2014_x86_64 \
    --python-version 3.12 \
    --only-binary=:all: \
    --upgrade \
    -r "$HERE/requirements.txt"

cp "$HERE/extract.py" "$BUILD/"

# Trim a few large bits we don't need at runtime.
find "$BUILD" -type d -name "__pycache__" -prune -exec rm -rf {} +
find "$BUILD" -type d -name "tests" -prune -exec rm -rf {} +

(cd "$BUILD" && zip -qr "$OUT" .)
echo "wrote $OUT ($(du -h "$OUT" | cut -f1))"
