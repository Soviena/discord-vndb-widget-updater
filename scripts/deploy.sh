#!/bin/bash
set -e

if [ -z "$TRIGGER_SECRET" ]; then
  echo "Error: TRIGGER_SECRET env var is not set."
  echo "Export it before running: TRIGGER_SECRET=<your-secret> npm run deploy"
  exit 1
fi

echo "Deploying worker..."
DEPLOY_OUT=$(npx wrangler deploy 2>&1)
echo "$DEPLOY_OUT"

# Anchor to indented lines only to avoid picking up preview/version URLs
WORKER_URL=$(echo "$DEPLOY_OUT" | grep -E '^\s+https://.*\.workers\.dev' | grep -oP 'https://\S+' | head -1)

if [ -z "$WORKER_URL" ]; then
  echo "Could not extract worker URL — trigger manually with:"
  echo "  curl -X POST -H 'X-Trigger-Secret: \$TRIGGER_SECRET' <your-worker-url>"
  exit 1
fi

echo ""
echo "Triggering immediate run at $WORKER_URL ..."
HTTP_CODE=$(curl -s -o /tmp/widget-response.json -w "%{http_code}" \
  -X POST \
  -H "X-Trigger-Secret: ${TRIGGER_SECRET}" \
  "$WORKER_URL")
echo "HTTP $HTTP_CODE"
cat /tmp/widget-response.json
echo ""
