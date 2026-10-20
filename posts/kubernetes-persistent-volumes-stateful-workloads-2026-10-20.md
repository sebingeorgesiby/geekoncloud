---
title: "Kubernetes Persistent Volumes: Running Stateful Workloads Right"
date: 2026-10-20
excerpt: "Deploy databases and stateful apps on K8s without losing data. PV, PVC, StorageClasses, and StatefulSets with production-ready configs."
tags: ["kubernetes","persistent-volumes","statefulsets","storage","databases"]
author: GeekOnCloud
draft: false
---

You want to run a database on Kubernetes. Your coworkers say it's a bad idea. They're wrong—but only if you understand what you're getting into.

Stateful workloads on Kubernetes have earned a reputation for complexity because people treat them like stateless deployments. They're not. Persistent volumes, storage classes, and StatefulSets exist for a reason. Master these primitives, and you'll run PostgreSQL, Redis, or Elasticsearch on Kubernetes with the same confidence you'd have on bare metal—plus the orchestration benefits.

Let's break down exactly how to do this without losing data.

## The Storage Stack You Need to Understand

Kubernetes abstracts storage through three key resources: PersistentVolume (PV), PersistentVolumeClaim (PVC), and StorageClass. Most tutorials explain these as "request and fulfill" but miss the critical operational details.

A PersistentVolume is a chunk of storage provisioned in your cluster—think of it as the actual disk. A PVC is a request for storage that binds to a PV. A StorageClass defines *how* storage gets provisioned dynamically.

Here's what matters in production: **reclaim policies and volume binding modes**.

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: fast-ssd
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
  iops: "5000"
  throughput: "250"
reclaimPolicy: Retain
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
```

`reclaimPolicy: Retain` prevents your data from being deleted when the PVC is removed. The default is `Delete`, which will wipe your production database if someone accidentally removes the claim. Always use `Retain` for stateful workloads.

`volumeBindingMode: WaitForFirstConsumer` delays PV provisioning until a pod actually needs it. This matters because it ensures the volume gets created in the same availability zone as your pod. Without this, you'll hit topology constraints where your pod can't mount a volume that was provisioned in a different AZ.

## StatefulSets: Not Just Deployments With Storage

A Deployment with a PVC attached sounds like it should work. It doesn't—not reliably. Here's why:

Deployments don't guarantee pod identity. When a pod restarts, it might get a different name, a different IP, and potentially a different volume (if you're using dynamic provisioning incorrectly). For databases that need stable network identities and consistent storage, this is catastrophic.

StatefulSets solve this by providing:
- Stable, predictable pod names (postgres-0, postgres-1, postgres-2)
- Ordered deployment and scaling
- Stable storage through `volumeClaimTemplates`

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
spec:
  serviceName: postgres
  replicas: 3
  selector:
    matchLabels:
      app: postgres
  template:
    metadata:
      labels:
        app: postgres
    spec:
      containers:
      - name: postgres
        image: postgres:15.4
        ports:
        - containerPort: 5432
        env:
        - name: POSTGRES_PASSWORD
          valueFrom:
            secretKeyRef:
              name: postgres-secret
              key: password
        - name: PGDATA
          value: /var/lib/postgresql/data/pgdata
        volumeMounts:
        - name: postgres-data
          mountPath: /var/lib/postgresql/data
        resources:
          requests:
            memory: "2Gi"
            cpu: "1"
          limits:
            memory: "4Gi"
            cpu: "2"
  volumeClaimTemplates:
  - metadata:
      name: postgres-data
    spec:
      accessModes: ["ReadWriteOnce"]
      storageClassName: fast-ssd
      resources:
        requests:
          storage: 100Gi
```

The `volumeClaimTemplates` section creates a unique PVC for each pod. When postgres-0 dies and restarts, it gets the *same* PVC—not a new one. This is non-negotiable for databases.

Note the `PGDATA` path. PostgreSQL requires the data directory to be a subdirectory of the mount point, not the mount point itself. This trips people up constantly.

## Backup Strategies That Actually Work

Running the database is the easy part. Recovering from disasters is where most Kubernetes stateful setups fail.

Your cloud provider's volume snapshots are your first line of defense. On AWS, you can use VolumeSnapshots through the CSI driver:

```bash
# Create a VolumeSnapshot
kubectl apply -f - <<EOF
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: postgres-snapshot-$(date +%Y%m%d-%H%M%S)
spec:
  volumeSnapshotClassName: ebs-snapshot-class
  source:
    persistentVolumeClaimName: postgres-data-postgres-0
EOF

# Verify the snapshot
kubectl get volumesnapshot -w
```

But snapshots alone aren't enough. They're point-in-time, which means you lose all transactions since the last snapshot. For databases, you need continuous backup.

For PostgreSQL, that means WAL archiving to S3. For MongoDB, it's oplog tailing. For Redis, RDB snapshots plus AOF persistence. The tooling varies, but the principle is the same: your backup strategy must handle both full snapshots and incremental changes.

I've seen teams lose data because they relied solely on EBS snapshots taken every 6 hours. That's 6 hours of transactions gone when things go wrong. Use Barman, pgBackRest, or Velero with application-consistent hooks.

## Topology and Anti-Affinity Rules

Running all your database replicas on the same node defeats the purpose of replication. Kubernetes won't prevent this by default.

```yaml
spec:
  template:
    spec:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchExpressions:
              - key: app
                operator: In
                values:
                - postgres
            topologyKey: kubernetes.io/hostname
```

This forces each PostgreSQL pod onto a different node. For true high availability, extend this to availability zones:

```yaml
topologyKey: topology.kubernetes.io/zone
```

But here's the catch: if you have 3 replicas and only 2 availability zones, one replica won't schedule with `requiredDuringSchedulingIgnoredDuringExecution`. Switch to `preferredDuringSchedulingIgnoredDuringExecution` for soft constraints, but understand you're trading availability guarantees for schedulability.

## Monitoring the Metrics That Matter

Standard Kubernetes metrics won't tell you if your database is healthy. You need:

- **IOPS and throughput**: Compare against your StorageClass provisioned values. If you're hitting gp3's 3000 IOPS baseline, you need to provision more.
- **Volume latency**: Anything over 10ms consistently for SSD storage indicates a problem.
- **Disk utilization**: Not just percentage, but rate of growth. A database at 60% but growing 5% daily needs attention now.

The CSI driver exposes metrics at the node level. Combine these with database-specific exporters (postgres_exporter, redis_exporter) for the full picture.

```bash
# Check CSI driver metrics
kubectl get --raw /apis/metrics.k8s.io/v1beta1/nodes | jq '.items[].usage'

# View PVC capacity
kubectl get pvc -o custom-columns=\
NAME:.metadata.name,\
CAPACITY:.status.capacity.storage,\
STORAGE-CLASS:.spec.storageClassName
```

## When It Actually Makes Sense

Not every stateful workload belongs on Kubernetes. Here's my litmus test:

**Run it on Kubernetes if**: Your team already operates Kubernetes confidently, you need dynamic scaling or multi-tenancy, and you have the operational maturity for database operations (backups, upgrades, failover testing).

**Use managed services if**: Database operations aren't your core competency, you need SLAs that require dedicated infrastructure, or you're running a single production database that doesn't benefit from Kubernetes orchestration.

The operational overhead of running PostgreSQL on Kubernetes is real—but so is the operational overhead of managing separate infrastructure. Choose based on your team's strengths, not industry dogma.

Your next step: deploy a test StatefulSet with the configurations above, intentionally delete pods and PVCs, and verify your data survives. Don't trust your setup until you've broken it and recovered.