#!/bin/bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DEST="$ROOT/src-tauri/python"
ARCHIVE_NAME="cpython-3.12.14+20260901-aarch64-apple-darwin-install_only_stripped.tar.gz"
ARCHIVE_URL="https://github.com/astral-sh/python-build-standalone/releases/download/20260901/cpython-3.12.14%2B20260901-aarch64-apple-darwin-install_only_stripped.tar.gz"
ARCHIVE_SHA256="81a359f1cfadd4da11766534c5913791cea55f26e1bb902cacd2a531bb1e4b2b"

if [[ $(uname -s) != Darwin || $(uname -m) != arm64 ]]; then
  echo "This runtime build supports Apple Silicon macOS only." >&2
  exit 1
fi

if [[ -x "$DEST/bin/python3" ]] && "$DEST/bin/python3" -c \
  'import fastapi, PIL, pydantic, uvicorn, onnxruntime' 2>/dev/null; then
  echo "Bundled Python runtime is already ready."
  exit 0
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
curl --fail --location --retry 3 --output "$TMP/$ARCHIVE_NAME" "$ARCHIVE_URL"
echo "$ARCHIVE_SHA256  $TMP/$ARCHIVE_NAME" | shasum -a 256 -c -

rm -rf "$DEST"
tar -xzf "$TMP/$ARCHIVE_NAME" -C "$TMP"
mv "$TMP/python" "$DEST"
"$DEST/bin/python3" -m pip install --disable-pip-version-check --no-cache-dir \
  -r "$ROOT/backend/requirements.txt"

find "$DEST" -type d \( -name __pycache__ -o -name tests -o -name test \) -prune \
  -exec rm -rf {} +
find "$DEST" -type f \( -name '*.pyc' -o -name '*.pyo' \) -delete
"$DEST/bin/python3" -c 'import fastapi, PIL, pydantic, uvicorn, onnxruntime'
echo "Prepared relocatable Python runtime at $DEST"
