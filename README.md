# Parkd

<p align="center">
  <img alt="Parkd logo" src="doc/logo/parkd.svg" height="200" />
</p>

Parkd is a Rust object storage project based on [Garage](https://garagehq.deuxfleurs.fr/), the distributed S3-compatible store by Deuxfleurs. This fork retains Garage's AGPL-3.0 license, attribution, storage format, Rust crate names, and `garage` executable. Parkd adds an operator console and a local setup workflow without replacing the underlying storage engine.

**Do not treat this project as a complete enterprise IaaS service.** It does not yet provide customer isolation, billing, erasure coding, object versioning, or Object Lock. See the capability matrix below before deploying it or promising any durability, security, or recovery guarantees.

## Quick start

Requirements: a Rust toolchain compatible with the project, OpenSSL, Python 3, and the build prerequisites in the [source build guide](doc/book/cookbook/from-source.md). From the repository root:

```sh
./script/parkd-setup.sh
cargo build --release
GARAGE_CONFIG_FILE="$PWD/parkd-local/garage.toml" ./target/release/garage server --single-node
```

Open `http://localhost:3903/console/` and enter the `admin_token` from `parkd-local/garage.toml`. The config and data are persistent in `parkd-local/`; metadata snapshots are scheduled every 24 hours in the same directory and are not off-site backups; the setup script creates unique secrets, restricts file permissions, binds services to loopback, and refuses to overwrite an existing configuration. To choose a different directory, pass it as the first argument to the script. Keep the config and its secrets private. The script does not create a default bucket or S3 key: use the console or the existing CLI to create them, and grant the key bucket permissions before using it. S3 clients must use the configured `parkd` signing region and `http://localhost:3900` endpoint.

This configuration is **for local development only**. It has one replica, no redundancy, no TLS, and no external backups. Loss of the node or its disk can mean loss of all data. For a real cluster, review the [deployment guide](doc/book/cookbook/real-world.md), [configuration reference](doc/book/reference-manual/configuration.md), and [operations documentation](doc/book/operations/). Do not expose the admin API directly to the internet. Use a protected network and TLS termination for remote access.

## Operator console

The console is embedded in the Rust admin server at `/console/`. It uses the existing v2 admin API on the same origin and requires an administrator token. The token is kept in page memory, not browser storage, and is cleared on disconnect or reload. A secure browser context is required to submit it. The console is an **operator tool, not a tenant portal**: an admin token can grant cluster-wide access, so never distribute it to customers. Protect the admin endpoint and its reverse proxy, and restrict who can access the console. The built-in server does not itself terminate TLS.

- Overview: live cluster health, logical object size, object and bucket counts, and a bucket snapshot.
- Buckets: filter the first 100 returned buckets, create a global bucket, grant or revoke bucket permissions for a key, and configure bucket quotas.
- Objects: browse current object keys and metadata by prefix, 100 per page, within a selected bucket. The bucket selector covers the first 100 buckets. The listing is not a snapshot and may change during concurrent writes or deletes; it does not upload, download, or delete objects.
- Access keys: view the first 100 keys and create a key. Copy its secret when prompted and grant it bucket permissions in the bucket view.
- Cluster: see node connection and zone information.
- Usage and billing: show current logical object size only, and explicitly mark billing data as unavailable. No prices, charges, invoices, or historical usage are calculated.
- Failed requests show unavailable data instead of sample values. Bucket and key lists are bounded to 100 results and are not complete inventories above that limit.

The object browser uses `POST /v2/ListBucketObjects` with JSON `bucketId`, optional `prefix`, optional `after`, and optional `limit` (1 to 1,000, default 100). The response contains `objects` and `nextAfter`; pass that key back as `after` with the same prefix until it is null. Keys and ETags are sensitive metadata. The endpoint requires an admin token authorized for `ListBucketObjects`, and pages are not transactionally consistent snapshots. An object inserted before the continuation key may not appear in later pages.

For narrowly delegated object metadata access, a generated admin token can be granted the exact scope `ListBucketObjects:<bucket-id>`. That token can browse only that bucket through `ListBucketObjects`, not enumerate buckets or use other admin endpoints. The token can still inspect its own token information. A plain `ListBucketObjects` scope or `*` grants access across buckets; token-management scopes can escalate privileges. Scoped tokens use the existing distributed admin-token table and revocations may not be immediate on every node. This is a limited API restriction, not a tenant account, a complete tenant isolation boundary, or an S3 credential. Do not give customers the global admin token or the operator console.

### Delegated object viewer

`/console/delegated.html` accepts generated bearer tokens whose scopes consist only of explicit `ListBucketObjects:<bucket-id>` entries. It shows keys, sizes, modification times, and ETags for those buckets, with prefix filtering and pagination. It does not provide object contents or S3 credentials. Tokens remain in tab memory. The server, not the page, enforces the bucket scope.

An operator can create a short-lived token through `POST /v2/CreateAdminToken`, authenticated with an administrator token, with a JSON body such as:

```json
{"name":"read-only object metadata","expiration":"2027-12-31T23:59:59Z","scope":["ListBucketObjects:BUCKET_ID"]}
```

Replace `BUCKET_ID` with the complete lowercase 64-character bucket ID and set an appropriate future expiration. The response contains `secretToken` only once and the token `id`. Share the secret securely; never put it in a URL. To revoke, call `POST /v2/DeleteAdminToken?id=TOKEN_ID` with an administrator token. Revocation can take time to propagate to all nodes. Do not grant `*`, plain `ListBucketObjects`, token-management scopes, or unrelated scopes to a viewer token. The viewer rejects such tokens, but that rejection does not reduce privileges already granted on the server.

The viewer is not a complete tenant portal and the admin endpoint must remain protected. For remote access, use HTTPS and a reverse proxy that permits only the viewer assets, `GetCurrentAdminTokenInfo`, and `ListBucketObjects` to delegated users; keep all other admin routes on an operator-only network. S3 key permissions, quotas, physical data, and resource usage are not isolated by this viewer.

Logical object size is not physical disk usage or a billable GB-hour measurement. Statistics and counters are subject to the underlying distributed system's consistency and availability. The cluster statistics endpoint omits object totals at 1,000 or more buckets and caps its bucket scan at 1,000,000. Reload or refresh to query again.

## Capability and requirements matrix

This describes the current fork, not a roadmap guarantee. For S3 operations and caveats consult the detailed [S3 compatibility matrix](doc/book/reference-manual/s3-compatibility.md).

| Area | Available in the inherited engine | Gaps and limits |
| --- | --- | --- |
| Infrastructure | Configurable replication, zone-aware placement, rebalancing, background repair and scrubbing, mixed hardware, separate metadata and data paths | No erasure coding profiles or storage pools/classes. An SSD metadata path is an operator configuration, not automatic NVMe tiering. Recovery behavior and zero-downtime upgrades depend on deployment and quorum; no new performance guarantees are made. |
| S3 | Core object operations, multipart, SigV4, presigned URLs, CORS, path and virtual-host style, limited lifecycle expiration, static websites, SSE-C | Not the entire S3 API. No object versioning or Object Lock; lifecycle transitions and JSON bucket policies are not supported. See the compatibility matrix for ACL and endpoint details. Bucket indexes have practical scaling limits, not an unlimited-object guarantee. |
| Access and provisioning | Access keys, per-key bucket permissions, bucket object and size quotas, admin provisioning API | No isolated customer tenants, per-tenant QoS, tenant quotas, or customer self-service portal. Access keys are not a complete tenancy model. Bucket quotas use distributed counters and are not strict under concurrent writes. |
| Security | SSE-C, encrypted cluster RPC, admin API tokens | No built-in S3/API TLS termination; use a properly configured TLS proxy. No SSE-S3 or SSE-KMS. Comprehensive compliance audit logging is not provided. |
| Operations | Prometheus metrics when compiled in, health API, repair and metadata snapshots | No complete alerting stack, verified off-site backup solution, customer access logs, or published RPO/RTO. Redundancy is not a backup. |
| Disaster recovery | Replicas can span configured zones | No active-passive site failover, failback orchestration, endpoint failover, or tested DR service is included. |
| Storage tiers | Replicated object storage | No Standard/IA/Archive pools, tier transitions, retrieval fees, or auto-tiering. |
| Billing | Current logical object and bucket counters in the admin API | No GB-hour, request, or egress billing ledger, pricing, payment integration, invoices, or customer billing dashboard. |
| Integrations | Static website server and Kubernetes node discovery | No bundled CDN, Velero integration, or S3-backed volume product. |

Version-specific GET, HEAD, DELETE, and copy requests are rejected, including `versionId=null`. Multi-object deletes containing any version ID are rejected as a whole. These are intentional compatibility changes to prevent accidental data loss. SSE-S3 and SSE-KMS requests are rejected rather than stored without the requested encryption.

An experimental in-memory Reed-Solomon stripe codec is available behind the `garage_block/experimental-ec` build feature. The codec can reconstruct and verify missing shard bytes, but it is not wired into object storage, does not place or repair shards on nodes, and is not a persistent format. Enabling the feature does not provide erasure-coded storage or change durability.

Versioning, WORM protection, billing, strong tenant isolation, erasure coding, and disaster recovery require substantial storage and control-plane work and cannot be safely emulated by the console. Use a system that supports them if they are mandatory today.

## Improvements in this fork

1. Embedded, same-origin operator console served by the existing Rust admin server; no separate frontend service or build is needed.
2. Cluster, bucket, and key views backed by real admin API calls, plus bucket and key creation and bucket-key permission management.
3. Explicit unavailable and partial-failure states, bounded list disclosure, and a billing view that does not invent costs.
4. Memory-only admin token handling, secure-context check, a restrictive content security policy, no-store asset responses, and browser security headers.
5. Repeatable local setup with generated secrets, persistent paths, loopback bindings, restrictive permissions, overwrite protection, and scheduled local metadata snapshots.
6. Integration coverage for console asset security and admin API authorization, plus frontend behavior tests.
7. Published capability gaps and links to the upstream S3 compatibility and operational documentation.
8. Bucket quota controls with explicit removal confirmation and protection against browser integer rounding.
9. Quota checks use wider arithmetic to avoid truncating large unsigned limits.
10. Requests for unsupported server-managed encryption, Object Lock, or non-Standard storage classes fail instead of silently ignoring those options.
11. Explicit object-version requests fail instead of accessing or deleting the current object. Multi-object deletes containing a version ID are rejected before any deletion. Internal object IDs are no longer advertised as S3 version IDs.
12. GitHub Actions checks for Rust unit and integration tests, console tests, and the local setup script.
13. Access logs and request spans omit URI query strings, and raw request headers and canonical signing requests are not logged. This reduces exposure of bearer tokens, presigned URLs, and customer encryption keys. Object paths, access key identifiers, and other diagnostic data can still appear in logs; protect log access and retention.
14. Prometheus alert rules and rule tests for node availability, quorum, disk space, resync errors, corruption, and S3 server errors. The local telemetry stack loads the rules; notification routing remains an operator responsibility.
15. A [backup and recovery drill checklist](doc/parkd-recovery.md) describing snapshot limits, off-site copies, restore verification, and the lack of a recovery guarantee.
16. Administrator-only object metadata browsing, backed by a bounded, prefix-filtered Rust API with continuation keys and explicit non-snapshot semantics. It does not grant S3 access or provide tenant isolation.
17. A feature-gated, in-memory erasure-code experiment with integrity-checked data and shard reconstruction. It is not used by the storage engine.
18. Bucket-specific `ListBucketObjects` token scopes, a delegated read-only viewer, and cross-key S3 authorization tests. These are initial access controls, not complete tenant isolation.

## Research notes

Commonly reported issues include the lack of object versioning, the cost of replication instead of erasure coding, region configuration mismatches, and the operational burden of backups, capacity monitoring, and unexpected request/egress charges. These reports guided the explicit capability matrix, signing-region guidance, console health visibility, and honest billing states. They do not establish that those larger missing features have been implemented.

- [Versioning discussion](https://github.com/suitenumerique/docs/discussions/1836)
- [Deployment experience and S3 region mismatch](https://github.com/ppat/homelab-ops-kubernetes-apps/issues/3611)
- [Self-hosting tradeoffs and monitoring](https://dev.to/alanwest/how-to-replace-cloud-object-storage-with-a-self-hosted-s3-compatible-setup-mim)
- [Storage billing granularity example](https://github.com/ovh/docs/blob/develop/pages/storage_and_backup/object_storage/s3_faq/guide.en-us.md)

## Development and testing

```sh
cargo test -p garage_api_s3 --features garage_model/sqlite
cargo test -p garage_api_common --features garage_model/sqlite
cargo test -p garage --test integration
cargo test -p garage_block --features experimental-ec --lib
node --check src/api/admin/console/app.js
./script/test-parkd-setup.sh
cd src/api/admin/console && npm ci && npm test
```

Rust integration tests start local processes and may require platform-specific build dependencies. See [CONTRIBUTING.md](CONTRIBUTING.md) and the upstream documentation in `doc/`. Garage was created by [Deuxfleurs](https://deuxfleurs.fr/) and is distributed under [AGPL-3.0](LICENSE).
