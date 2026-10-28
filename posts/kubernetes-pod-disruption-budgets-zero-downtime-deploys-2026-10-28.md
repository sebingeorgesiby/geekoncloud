---
title: "Kubernetes PodDisruptionBudgets: Zero-Downtime Deploys Guide"
date: 2026-10-28
excerpt: "Configure PDBs to prevent outages during rolling updates, node drains, and cluster upgrades. Real configs and common mistakes to avoid."
tags: ["kubernetes","high-availability","deployments","pod-disruption-budgets"]
author: GeekOnCloud
draft: false
---

You've got a solid Kubernetes deployment pipeline. Rolling updates work flawlessly. Then a node gets drained for maintenance, and suddenly three replicas of your payment service vanish simultaneously. Requests start failing. PagerDuty lights up. Your "zero downtime" infrastructure just caused an outage.

Pod Disruption Budgets (PDBs) exist specifically to prevent this scenario. They're one of the most underused reliability features in Kubernetes, and getting them wrong—or not using them at all—is a common cause of preventable production incidents.

## What Actually Causes Involuntary Pod Disruption

Before diving into PDBs, you need to understand what you're protecting against. Voluntary disruptions include things you control: deployments, scaling down, deleting pods manually. Involuntary disruptions are the surprise guests: node failures, kernel panics, out-of-memory kills.

But there's a middle category that catches teams off guard: **administrative operations**. These are technically voluntary, but they happen outside your deployment pipeline:

- `kubectl drain` during node maintenance
- Cluster autoscaler removing underutilized nodes
- Spot/preemptible instance reclamation
- Kubernetes version upgrades
- Node pool rotations

Without PDBs, the Kubernetes scheduler has no constraints when evicting pods during these operations. It will happily terminate all your replicas at once if that's the fastest path to draining a node.

## Creating Your First Pod Disruption Budget

A PDB is a simple resource that tells Kubernetes: "Never let available pods for this workload drop below X." Here's a basic example for a critical API service:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: api-gateway-pdb
  namespace: production
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: api-gateway
```

This PDB guarantees that at least 2 pods matching the `app: api-gateway` label remain running during any voluntary disruption. If you have 3 replicas and someone runs `kubectl drain`, the eviction will block until each pod is replaced before the next one is terminated.

The alternative syntax uses `maxUnavailable`:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: worker-pdb
  namespace: production
spec:
  maxUnavailable: 1
  selector:
    matchLabels:
      app: background-worker
```

This says "at most 1 pod can be unavailable at any time." For a 5-replica deployment, 4 must always be running.

**Critical distinction**: You can specify either `minAvailable` or `maxUnavailable`, never both. They're mutually exclusive fields.

## Choosing Between minAvailable and maxUnavailable

This decision matters more than most teams realize. The wrong choice creates either unnecessary deployment friction or inadequate protection.

**Use `maxUnavailable` when:**
- You have variable replica counts (HPA-managed workloads)
- You want consistent disruption tolerance regardless of scale
- You're okay with the budget being relative to current replica count

**Use `minAvailable` when:**
- You have a hard minimum for serving capacity
- You run quorum-based systems (etcd, Zookeeper, Cassandra)
- You need an absolute floor regardless of desired replicas

Here's the gotcha with `minAvailable`: if you set `minAvailable: 2` on a deployment with 2 replicas, you've created a PDB that blocks ALL voluntary disruptions. No pod can ever be evicted because you'd immediately violate the minimum. This is sometimes intentional for hyper-critical services, but usually it's a configuration mistake that causes node drains to hang indefinitely.

For most stateless services, `maxUnavailable: 1` or `maxUnavailable: 25%` is the right choice. Percentages scale naturally with your workload.

## Real-World PDB Patterns That Actually Work

Here's a production-tested PDB setup for a typical microservices environment:

```yaml
---
# High-traffic stateless API: allow 25% disruption
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: checkout-api-pdb
  namespace: production
spec:
  maxUnavailable: 25%
  selector:
    matchLabels:
      app: checkout-api
---
# Singleton worker (exactly 1 replica): block all disruption
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: scheduler-pdb
  namespace: production
spec:
  maxUnavailable: 0
  selector:
    matchLabels:
      app: job-scheduler
---
# 3-node Redis Sentinel: maintain quorum
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: redis-sentinel-pdb
  namespace: production
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: redis-sentinel
```

Notice the `maxUnavailable: 0` pattern. This creates an "undrainable" workload—useful for controllers, schedulers, or any singleton that must complete work before relocating. The tradeoff: node drains will block until you manually delete the pod or scale down the deployment.

For stateful sets running databases, always calculate based on quorum requirements. A 3-node etcd cluster needs 2 nodes for quorum, so `minAvailable: 2` is correct. A 5-node cluster can tolerate 2 failures, so `minAvailable: 3` or `maxUnavailable: 2` both work.

## Debugging PDB Issues in Production

When node drains hang or cluster operations stall, PDBs are often the culprit. Here's how to diagnose:

```bash
# List all PDBs and their current status
kubectl get pdb -A

# Check specific PDB details - look for ALLOWED DISRUPTIONS
kubectl get pdb api-gateway-pdb -n production -o wide

# Get detailed status including disruption conditions
kubectl describe pdb api-gateway-pdb -n production

# Find pods protected by a specific PDB
kubectl get pods -n production -l app=api-gateway

# Check events for eviction failures
kubectl get events -n production --field-selector reason=EvictionRejected
```

The `ALLOWED DISRUPTIONS` column in `kubectl get pdb` output is your key metric. If it shows 0, no pods can be evicted. If a drain operation is stuck, this is usually why.

Common issues and fixes:

**Drain hangs indefinitely**: Your PDB allows 0 disruptions, either because `minAvailable` equals current replicas or because pods aren't becoming ready. Check pod health and readiness probes.

**PDB has no effect**: The label selector doesn't match your pods. This is almost always a typo or mismatch between the PDB selector and deployment labels. Run `kubectl get pods -l <your-selector>` to verify matches.

**Deploys are slow**: Your PDB combined with slow readiness probes creates a bottleneck. Each pod must become ready before the next is terminated. Optimize probe timing or increase `maxUnavailable`.

## Integrating PDBs With Your Deployment Strategy

PDBs work alongside—not instead of—deployment strategies. Your rolling update configuration in the Deployment spec controls how new pods are introduced. The PDB controls how existing pods can be evicted.

For a deployment with aggressive availability requirements:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-service
  namespace: production
spec:
  replicas: 4
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0  # Never reduce capacity during deploys
  template:
    spec:
      containers:
      - name: payment-service
        readinessProbe:
          httpGet:
            path: /health
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 3
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: payment-service-pdb
  namespace: production
spec:
  maxUnavailable: 1  # Allow 1 eviction during node operations
  selector:
    matchLabels:
      app: payment-service
```

The deployment's `maxUnavailable: 0` ensures deployments never reduce running capacity. The PDB's `maxUnavailable: 1` allows node maintenance while keeping 3 of 4 pods running.

One final operational tip: add PDBs to your infrastructure-as-code alongside deployments. Terraform, Helm, and Kustomize all support PDB resources. Treating PDBs as an afterthought means they'll be forgotten, and you'll rediscover their importance at 3 AM during an unexpected node rotation.

Start by auditing your production namespace: `kubectl get deployments -o name | xargs -I {} kubectl get pdb -l app={} 2>/dev/null || echo "Missing PDB for {}"`. Every service running more than one replica should have a PDB. No exceptions.