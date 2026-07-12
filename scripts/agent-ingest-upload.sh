#!/usr/bin/env bash
# Manual verification / example client for POST /api/agent-ingest - see
# DEPLOYMENT.md ("Remote HTTP ingest") for the full endpoint documentation.
#
# Usage:
#   PLANTLAB_INGEST_TOKEN=<token> \
#   CAPTURE_SOURCE_ID=<capture-source-id> \
#   [PLANTLAB_HOST=http://<coordinator-lan-ip>:3000] \
#     ./scripts/agent-ingest-upload.sh <image-path> <captureId>
#
# Run this from any machine on the same LAN or Tailscale network as the
# coordinator (e.g. bokchoy, a Raspberry Pi capture node, or another Ubuntu
# machine for manual testing) - ordinary HTTP only, no Taildrop, file-share
# APIs, SMB, NFS, or Git involved.
#
# Re-running with the same <captureId> and the same image is a safe,
# idempotent retry (200 OK, no duplicate file/row). Re-running with the
# same <captureId> but a different image is rejected (409 Conflict) and
# never overwrites the original accepted upload.
set -euo pipefail

if [ $# -lt 2 ]; then
  echo "Usage: PLANTLAB_INGEST_TOKEN=... CAPTURE_SOURCE_ID=... $0 <image-path> <captureId>" >&2
  exit 1
fi

IMAGE_PATH="$1"
CAPTURE_ID="$2"
HOST="${PLANTLAB_HOST:-http://localhost:3000}"

: "${PLANTLAB_INGEST_TOKEN:?Set PLANTLAB_INGEST_TOKEN to the coordinator's configured agent-ingest token}"
: "${CAPTURE_SOURCE_ID:?Set CAPTURE_SOURCE_ID to an existing CaptureSource id (see GET /api/capture-sources)}"

EXPECTED_SHA256=$(sha256sum "$IMAGE_PATH" | cut -d' ' -f1)
EXPECTED_BYTE_SIZE=$(stat -c%s "$IMAGE_PATH")
CAPTURED_AT=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)

METADATA=$(cat <<EOF
{
  "captureId": "$CAPTURE_ID",
  "capturedAt": "$CAPTURED_AT",
  "captureSourceId": "$CAPTURE_SOURCE_ID",
  "originalFilename": "$(basename "$IMAGE_PATH")",
  "expectedSha256": "$EXPECTED_SHA256",
  "expectedByteSize": $EXPECTED_BYTE_SIZE,
  "mimeType": "image/jpeg"
}
EOF
)

curl -i -X POST "$HOST/api/agent-ingest" \
  -H "Authorization: Bearer $PLANTLAB_INGEST_TOKEN" \
  -F "metadata=$METADATA;type=application/json" \
  -F "image=@$IMAGE_PATH;type=image/jpeg"
