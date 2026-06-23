---
title: "Kubernetes Persistent Volumes: Running Stateful Workloads Right"
date: 2026-06-23
excerpt: "Deploy databases and stateful apps on K8s with PVs, StorageClasses, and StatefulSets. Real configs, performance tuning, and backup strategies included."
tags: ["kubernetes","persistent-volumes","statefulsets","storage","databases"]
author: GeekOnCloud
draft: false
---

Picture this: your PostgreSQL pod just got rescheduled to a different node, and your database is empty. No data, no users, no transactions. Just a fresh PostgreSQL instance wondering where its life went. This is what happens when you run stateful workloads on Kubernetes without understanding persistent volumes—and I've seen production databases wiped this way.

Kubernetes was built for stateless workloads. The entire model assumes pods are cattle, not pets—disposable, replaceable, identical. But the real world runs on state. Databases, message queues, file uploads, session stores. Let's talk about how to actually run these workloads without losing sleep (or data).

## The Storage Stack: What Actually Happens When You Request a Volume

Before writing any YAML, you need to understand the components. Kubernetes storage has three layers that work together:

**PersistentVolume (PV)** — The actual storage resource. Think of it as a disk that exists somewhere (cloud provider, NFS server, local node). It has a lifecycle independent of any pod.

**PersistentVolumeClaim (PVC)** — A request for storage. Pods don't talk to PVs directly; they claim storage through PVCs. This abstraction lets you swap underlying storage without touching pod specs.

**StorageClass** — The template that tells Kubernetes how to provision PVs dynamically. This is where you define "when someone asks for storage, create it from AWS EBS with gp3 disks."

The flow: Pod references PVC → PVC binds to PV (existing or dynamically created via StorageClass) → PV maps to actual storage backend.

Here's what dynamic provisioning looks like on AWS EKS with the EBS CSI driver:

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: ebs-gp3
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
  iops: "4000"
  throughput: "200"
  encrypted: "true"
  fsType: ext4
reclaimPolicy: Retain
allowVolumeExpansion: true
volumeBindingMode: WaitForFirstConsumer
```

Critical settings here: `WaitForFirstConsumer` delays volume creation until a pod actually needs it—this ensures the EBS volume gets created in the same AZ as the node running your pod. Without this, you'll hit cross-AZ mounting failures. `reclaimPolicy: Retain` keeps your data when the PVC is deleted—set this for anything you care about.

## StatefulSets: The Right Controller for the Job

Deployments don't cut it for stateful workloads. When a Deployment scales down, it picks pods randomly. When it scales up, pods get random names. For a database replica set or a Kafka cluster, this is chaos.

StatefulSets provide three guarantees you need:

1. **Stable network identities** — Pods get predictable names: `postgres-0`, `postgres-1`, `postgres-2`. DNS entries follow: `postgres-0.postgres-headless.default.svc.cluster.local`

2. **Ordered deployment and scaling** — Pods start in order (0, then 1, then 2) and terminate in reverse. Essential for primary/replica setups.

3. **Stable storage** — Each pod gets its own PVC that follows it across rescheduling.

Here's a real StatefulSet for PostgreSQL with proper volume handling:

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
spec:
  serviceName: postgres-headless
  replicas: 3
  podManagementPolicy: OrderedReady
  selector:
    matchLabels:
      app: postgres
  template:
    metadata:
      labels:
        app: postgres
    spec:
      terminationGracePeriodSeconds: 120
      containers:
      - name: postgres
        image: postgres:15.4
        ports:
        - containerPort: 5432
        env:
        - name: PGDATA
          value: /var/lib/postgresql/data/pgdata
        - name: POSTGRES_PASSWORD
          valueFrom:
            secretKeyRef:
              name: postgres-secret
              key: password
        volumeMounts:
        - name: data
          mountPath: /var/lib/postgresql/data
        resources:
          requests:
            memory: "2Gi"
            cpu: "1000m"
          limits:
            memory: "4Gi"
            cpu: "2000m"
        readinessProbe:
          exec:
            command: ["pg_isready", "-U", "postgres"]
          initialDelaySeconds: 5
          periodSeconds: 10
        livenessProbe:
          exec:
            command: ["pg_isready", "-U", "postgres"]
          initialDelaySeconds: 30
          periodSeconds: 30
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: ["ReadWriteOnce"]
      storageClassName: ebs-gp3
      resources:
        requests:
          storage: 100Gi
```

The `volumeClaimTemplates` section is the key. This creates a PVC for each replica: `data-postgres-0`, `data-postgres-1`, `data-postgres-2`. When `postgres-1` dies and gets rescheduled, it reattaches to `data-postgres-1`—same data, different node.

The `terminationGracePeriodSeconds: 120` gives PostgreSQL time to checkpoint and shut down cleanly. Default is 30 seconds, which isn't enough for a loaded database.

## Access Modes and the Multi-Node Problem

Most block storage (EBS, Azure Disk, GCE PD) only supports `ReadWriteOnce`—one node can mount the volume at a time. This works fine for databases (you typically only want one writer anyway), but fails hard for shared storage scenarios.

For workloads needing concurrent access from multiple pods across nodes, you need:

**ReadWriteMany (RWX)** — Multiple nodes can mount and write. Options include EFS (AWS), Azure Files, NFS, or CephFS.

**ReadOnlyMany (ROX)** — Multiple nodes can mount read-only. Useful for serving static assets.

Setting up EFS for a WordPress deployment that needs shared media uploads:

```bash
# Create EFS filesystem
aws efs create-file-system \
  --performance-mode generalPurpose \
  --throughput-mode bursting \
  --encrypted \
  --tags Key=Name,Value=wordpress-media \
  --region us-east-1

# Get the filesystem ID
EFS_ID=$(aws efs describe-file-systems \
  --query "FileSystems[?Name=='wordpress-media'].FileSystemId" \
  --output text)

# Create mount targets in each subnet (required for each AZ)
for SUBNET in subnet-abc123 subnet-def456; do
  aws efs create-mount-target \
    --file-system-id $EFS_ID \
    --subnet-id $SUBNET \
    --security-groups sg-xyz789
done
```

Then reference it in a StorageClass using the EFS CSI driver with `ReadWriteMany` access mode.

## Backup Strategies That Actually Work

Persistent volumes aren't backups. EBS volumes can fail. AZs can fail. You need a real backup strategy.

**Volume Snapshots** — Kubernetes 1.20+ supports VolumeSnapshots as first-class objects. Install the snapshot controller and CRDs, then:

```yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: postgres-snapshot-20241215
spec:
  volumeSnapshotClassName: ebs-snapshot-class
  source:
    persistentVolumeClaimName: data-postgres-0
```

For PostgreSQL specifically, snapshots without proper fencing can capture inconsistent data. Use `pg_start_backup()` / `pg_stop_backup()` or a tool like Velero with hooks:

```bash
velero backup create postgres-backup \
  --include-namespaces database \
  --include-resources persistentvolumeclaims,persistentvolumes \
  --hooks.pre.postgres.container=postgres \
  --hooks.pre.postgres.command='["/bin/bash", "-c", "pg_dump -U postgres > /backup/pre-snapshot.sql"]'
```

Test your restores. A backup you haven't tested is a hypothesis, not a backup. Schedule monthly restore drills to a separate namespace.

## Performance Tuning: Because IOPS Matter

Default storage classes are not optimized for databases. I've seen production MySQL running on gp2 volumes hitting IOPS limits at 3000 IOPS while the ops team blamed the application.

For write-heavy workloads on AWS:

- gp3: baseline 3000 IOPS, 125 MiB/s. Can provision up to 16000 IOPS and 1000 MiB/s independently.
- io2: up to 64000 IOPS, designed for critical databases.

Check your current IOPS consumption:

```bash
aws cloudwatch get-metric-statistics \
  --namespace AWS/EBS \
  --metric-name VolumeReadOps \
  --dimensions Name=VolumeId,Value=vol-abc123 \
  --start-time 2024-12-14T00:00:00Z \
  --end-time 2024-12-15T00:00:00Z \
  --period 3600 \
  --statistics Average
```

If you're consistently hitting provisioned IOPS, you're throttling. Either provision more IOPS or move to io2.

For local NVMe performance (like i3 instances), consider local PVs with the `local-path-provisioner`. You lose cross-node mobility but gain 100k+ IOPS. Suitable for caching layers or when you're running application-level replication (like Cassandra or CockroachDB).

## What to Do Monday Morning

Start by auditing your current storage classes: `kubectl get storageclass -o yaml`. Check `reclaimPolicy`—if it says Delete, fix it now for any storage class used by databases. Then pick one stateful workload currently running with ephemeral storage and migrate it to a StatefulSet with persistent volumes. Run a restore test before the end of the week.