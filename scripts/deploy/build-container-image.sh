#!/usr/bin/env bash
set -euo pipefail

app="${1:?app is required}"
revision="${2:?revision is required}"
image="${3:?image is required}"
case "$app" in
  simulator|cockpit|streaming-backend|mcp-tools|console) ;;
  *) echo 'Invalid application.' >&2; exit 1 ;;
esac
if [[ ! "$revision" =~ ^[a-f0-9]{40}$ ]]; then
  echo 'Invalid full source revision.' >&2
  exit 1
fi

docker build --pull --platform linux/amd64 \
  --label "org.opencontainers.image.revision=$revision" \
  --tag "$image" \
  --file "apps/$app/Containerfile" .
