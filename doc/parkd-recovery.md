# Parkd backup and recovery checklist

This is an operator checklist, not an automated disaster recovery service. Parkd does not provide a tested active-passive failover, an endpoint failover controller, or published RPO and RTO guarantees. Establish your own targets and verify them through drills.

## What to protect

- Object data in every bucket, including application-specific metadata and access controls.
- A consistent metadata snapshot from each node, node configuration, cluster layout records, and secret material needed to operate the cluster.
- An independent, encrypted, access-controlled off-site copy with a retention policy. Keep restore credentials separate from the live cluster.

Replicas and local snapshots are not independent backups. A metadata snapshot does not include object data. Parkd does not implement S3 versioning or Object Lock, so accidental deletion and ransomware cannot be recovered through those features. Do not rely on a mirror that automatically propagates deletions as the only copy.

## Schedule and verify

1. Configure `metadata_snapshots_dir` and `metadata_auto_snapshot_interval` on each node. Check disk capacity first. The engine keeps only its two most recent local snapshots, and a snapshot can temporarily increase disk use and affect performance. See the [snapshot configuration](book/reference-manual/configuration.md#metadata_auto_snapshot_interval).
2. For an on-demand snapshot, run `garage meta snapshot --all` from a node with cluster access. Verify that every expected node reports success and check the command exit status. The snapshots are node-local and are not a cluster-wide point-in-time transaction.
3. Copy completed snapshots, configuration, and separately protected secrets to independent storage using your backup system. Record the node ID, engine version, snapshot time, and checksums. Encrypt copies in transit and at rest. Monitor failed jobs and snapshot age. Test your restore credentials.
4. Back up object data independently with a tool and retention policy appropriate to your applications. Define a write quiescence or application consistency procedure if an atomic point-in-time copy is required. Verify object counts and checksums against the backup; snapshot metadata alone cannot restore the data blocks.
5. Configure Prometheus and an Alertmanager receiver. The [local alert rules](../script/telemetry/README.md) do not deliver notifications by themselves.

## Recovery drill

Use a separate, isolated test network and storage. Never point a drill at production DNS, production disks, or production credentials.

1. Record the backup times, start time, and intended application consistency point. Verify the integrity of both metadata and object backups before restoring.
2. Restore a representative isolated environment using the [metadata recovery guide](book/operations/recovering.md) and your object backup tool's restore procedure. Preserve the original backups. Do not replace a live node's metadata with an old snapshot while it is running.
3. Verify S3 authentication, bucket permissions, object contents, checksums, and representative application behavior. Record missing or inconsistent data, the observed recovery point, and the time needed to restore service.
4. Review logs, alert delivery, and the documented steps. Assign owners and dates for failures, repeat the drill regularly, and revise targets only after successful measurements.

No failover or failback guarantees follow from completing this checklist. Restoring one node from a metadata snapshot may require synchronization from other nodes; the recovery guide explains the risks and available procedures.
