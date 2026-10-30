#!/bin/sh
set -eu

# Create a local single-node configuration without overwriting existing data.
command -v openssl >/dev/null || { echo 'openssl is required' >&2; exit 1; }
command -v python3 >/dev/null || { echo 'python3 is required' >&2; exit 1; }
root=${1:-./parkd-local}
umask 077
mkdir -p "$root"
root=$(cd "$root" && pwd -P)
config="$root/garage.toml"
if [ -e "$config" ]; then
  echo "Refusing to overwrite $config" >&2
  exit 1
fi
mkdir -p "$root/meta" "$root/data" "$root/snapshots"
rpc_secret=$(openssl rand -hex 32)
admin_token=$(openssl rand -hex 32)
metrics_token=$(openssl rand -hex 32)
export root rpc_secret admin_token metrics_token
python3 - <<'PY'
import json
import os
from pathlib import Path

root = Path(os.environ['root'])
q = json.dumps
config = f'''metadata_dir = {q(str(root / "meta"))}
data_dir = {q(str(root / "data"))}
metadata_snapshots_dir = {q(str(root / "snapshots"))}
metadata_auto_snapshot_interval = "24h"
db_engine = "sqlite"
replication_factor = 1
rpc_bind_addr = "127.0.0.1:3901"
rpc_public_addr = "127.0.0.1:3901"
rpc_secret = {q(os.environ["rpc_secret"])}

[s3_api]
s3_region = "parkd"
api_bind_addr = "127.0.0.1:3900"
root_domain = ".s3.parkd.localhost"

[admin]
api_bind_addr = "127.0.0.1:3903"
admin_token = {q(os.environ["admin_token"])}
metrics_token = {q(os.environ["metrics_token"])}
'''
# Exclusive creation prevents a concurrent setup from replacing a configuration.
with (root / 'garage.toml').open('x', encoding='utf-8') as f:
    f.write(config)
PY
unset rpc_secret admin_token metrics_token
printf '\nLocal configuration created at %s\n' "$config"
printf '%s\n' 'Build with: cargo build --release'
printf 'Start with: GARAGE_CONFIG_FILE="%s" ./target/release/garage server --single-node\n' "$config"
printf '%s\n' 'Open http://localhost:3903/console/ and use the admin_token from the configuration.'
printf '%s\n' 'This is a local single-node setup with no redundancy. Do not use it for production.'
