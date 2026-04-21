#!/usr/bin/env bash
# Build and deploy the site to DreamHost via rsync over SSH.
# Uses the "top100sfcom" Host alias defined in ~/.ssh/config.

set -euo pipefail

SSH_HOST="top100sfcom"
REMOTE_PATH="~/top100sf.com/"

cd "$(dirname "$0")/.."

echo "==> Building dist/"
npm run dist

echo "==> Deploying dist/ to ${SSH_HOST}:${REMOTE_PATH}"
rsync -avz --delete \
  --exclude '.DS_Store' \
  --exclude '.dh-diag' \
  --exclude 'favicon.gif' \
  --exclude 'favicon.ico' \
  --exclude 'logs/' \
  dist/ "${SSH_HOST}:${REMOTE_PATH}"

echo "==> Done. https://top100sf.com"
