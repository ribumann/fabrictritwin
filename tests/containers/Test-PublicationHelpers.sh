#!/usr/bin/env bash
set -euo pipefail

tmp="$(mktemp -d)"
trap 'rm -f "$tmp/docker" "$tmp/build-args" "$tmp/push-output"; rmdir "$tmp"' EXIT
cat > "$tmp/docker" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$TEST_BUILD_ARGS"
EOF
chmod +x "$tmp/docker"
export PATH="$tmp:$PATH" TEST_BUILD_ARGS="$tmp/build-args"
revision=0123456789abcdef0123456789abcdef01234567
for app in simulator cockpit streaming-backend mcp-tools console; do
  bash scripts/deploy/build-container-image.sh "$app" "$revision" "local/$app:$revision"
  grep -Fx -- "apps/$app/Containerfile" "$TEST_BUILD_ARGS" > /dev/null
  grep -Fx -- "org.opencontainers.image.revision=$revision" "$TEST_BUILD_ARGS" > /dev/null
  grep -Fx -- "local/$app:$revision" "$TEST_BUILD_ARGS" > /dev/null
  grep -Fx -- 'linux/amd64' "$TEST_BUILD_ARGS" > /dev/null
done
if bash scripts/deploy/build-container-image.sh '../bad' "$revision" image 2>/dev/null; then
  echo 'Invalid application was accepted.' >&2; exit 1
fi
if bash scripts/deploy/build-container-image.sh cockpit bad image 2>/dev/null; then
  echo 'Invalid revision was accepted.' >&2; exit 1
fi
digest="sha256:$(printf 'a%.0s' {1..64})"
printf 'tag: digest: %s size: 1234\n' "$digest" > "$tmp/push-output"
[[ "$(bash scripts/deploy/read-push-digest.sh "$tmp/push-output")" == "$digest" ]]
printf 'digest: sha256:abcd size: 1234\n' > "$tmp/push-output"
if bash scripts/deploy/read-push-digest.sh "$tmp/push-output" 2>/dev/null; then
  echo 'Invalid digest was accepted.' >&2; exit 1
fi
printf 'tag: digest: %s size: 1\ntag: digest: %s size: 1\n' "$digest" "$digest" > "$tmp/push-output"
if bash scripts/deploy/read-push-digest.sh "$tmp/push-output" 2>/dev/null; then
  echo 'Ambiguous digest was accepted.' >&2; exit 1
fi
echo 'Publication helper tests passed.'
