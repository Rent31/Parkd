#!/bin/sh
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
"$here/script/parkd-setup.sh" "$tmp/first" >/dev/null
"$here/script/parkd-setup.sh" "$tmp/second" >/dev/null
first="$tmp/first/garage.toml"
second="$tmp/second/garage.toml"
test "$(stat -c %a "$first")" = 600
grep -q 'replication_factor = 1' "$first"
grep -q 'metadata_auto_snapshot_interval = "24h"' "$first"
test -d "$tmp/first/snapshots"
grep -q 'api_bind_addr = "127.0.0.1:3903"' "$first"
test "$(grep '^rpc_secret' "$first")" != "$(grep '^rpc_secret' "$second")"
test "$(grep '^admin_token' "$first")" != "$(grep '^admin_token' "$second")"
cp "$first" "$tmp/original"
if "$here/script/parkd-setup.sh" "$tmp/first" >/dev/null 2>&1; then
  echo 'Setup overwrote an existing configuration' >&2
  exit 1
fi
cmp "$first" "$tmp/original"
echo 'Setup tests passed'
