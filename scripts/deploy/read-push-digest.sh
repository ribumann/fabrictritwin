#!/usr/bin/env bash
set -euo pipefail

output="${1:?push output file is required}"
digest="$(sed -nE 's/^.*digest: (sha256:[a-f0-9]{64}) size: [0-9]+[[:space:]]*$/\1/p' "$output")"
if [[ ! "$digest" =~ ^sha256:[a-f0-9]{64}$ ]]; then
  echo 'Push completed but its manifest digest was not verified; inspect the registry before retrying.' >&2
  exit 1
fi
printf '%s\n' "$digest"
