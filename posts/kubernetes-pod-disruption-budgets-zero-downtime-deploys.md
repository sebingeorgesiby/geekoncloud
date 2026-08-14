---
title: "Kubernetes Pod Disruption Budgets: Zero-Downtime Deploys"
date: 2026-08-14
excerpt: "Stop losing availability during rollouts. Configure PDBs correctly with real examples, common pitfalls, and production-tested patterns."
tags: ["kubernetes","high-availability","deployments","pod-disruption-budgets","sre"]
author: GeekOnCloud
draft: false
---

You're running a Kubernetes deployment with 3 replicas. CI kicks off a rolling update. Kubernetes terminates pod 1, starts the replacement. Then node autoscaler decides to reclaim a spot instance — kills pod 2. Meanwhile, the cluster autoscaler is rebalancing and evicts pod 3. For about 47 seconds, you have zero healthy pods. Your users get 502s. Your on-call gets paged.

This isn't a hypothetical scenario. I've watched this exact sequence happen on a production cluster running 200+ microservices. The fix? A 6-line YAML file called a PodDisruptionBudget that took 30 seconds to write and would have prevented the entire incident.

## What PodDisruptionBudgets Actually Do

A PodDisruptionBudget (PDB) is a contract between your application and Kubernetes. It tells the control plane: "I need at least X pods running at all times" or "you can only disrupt Y pods simultaneously."

PDBs protect against *voluntary* disruptions — operations that Kubernetes initiates intentionally:
- `kubectl drain` during node maintenance
- Cluster autoscaler removing underutilized nodes
- Node upgrades and kernel patches
- Spot/preemptible instance reclamation (when handled gracefully)

They don't protect against involuntary disruptions like node hardware failures, OOM kills, or your application crashing. Those require different strategies (more replicas, proper resource limits, health checks).

The key insight: without a PDB, Kubernetes will happily evict all your pods simultaneously if that's the most efficient path. It doesn't know your app needs N instances for quorum or to handle load. You have to tell it.

## The Two Flavors: minAvailable vs maxUnavailable

You get two mutually exclusive options for defining your disruption tolerance:

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

This says "always keep at least 2 pods running." If you have 3 replicas and something tries to evict one, Kubernetes allows it. Try to evict a second while the first is still terminating? Blocked.

The alternative approach:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: worker-pool-pdb
  namespace: production
spec:
  maxUnavailable: 1
  selector:
    matchLabels:
      app: worker-pool
```

This says "only 1 pod can be unavailable at any time." With 10 replicas, 9 must always be running.

You can also use percentages: `minAvailable: 50%` or `maxUnavailable: 25%`. Percentages round up for minAvailable and down for maxUnavailable — Kubernetes errs on the side of availability.

**Which should you use?** 

Use `minAvailable` when you have hard requirements — databases needing quorum (etcd needs 2 of 3, Cassandra might need 2 of 3 for consistency), services with minimum capacity requirements.

Use `maxUnavailable` when you're thinking about deployment velocity — "I want to roll out quickly, so allow 25% to be down simultaneously" or when replica counts vary significantly.

## Real-World PDB Patterns That Actually Work

Here's my production playbook for different workload types:

**Stateless API services (3+ replicas):**
```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: user-service-pdb
spec:
  maxUnavailable: 1
  selector:
    matchLabels:
      app: user-service
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: user-service
spec:
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0  # Coordinate with PDB
```

Notice the `maxUnavailable: 0` in the deployment strategy. This means rolling updates create new pods before killing old ones. Combined with the PDB, you get zero-downtime deploys AND protection during node maintenance.

**Databases and stateful workloads:**
```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: postgres-pdb
spec:
  minAvailable: 2  # Maintain quorum for streaming replication
  selector:
    matchLabels:
      app: postgres
      role: replica  # Don't include primary in same PDB
```

For databases, I create separate PDBs for primary and replicas. The primary gets `minAvailable: 1` (it's only one pod anyway, but documenting the requirement matters). Replicas get `minAvailable: N-1` where N is replica count.

**Singleton workloads (1 replica):**
```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: scheduler-pdb
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app: job-scheduler
```

This seems pointless — you're saying "keep 1 of 1 running" — but it serves a purpose. It blocks `kubectl drain` from evicting this pod until a replacement is running elsewhere. The drain will wait until your scheduler successfully starts on another node.

## When PDBs Block Operations (And How to Handle It)

PDBs can deadlock your cluster operations. Common scenarios:

**Scenario 1: Aggressive PDB + not enough nodes**

You have 3 pods with `minAvailable: 3` and need to drain a node. The PDB blocks all evictions. The drain command hangs forever.

```bash
# This will hang
kubectl drain node-1 --ignore-daemonsets --delete-emptydir-data

# Check what's blocking
kubectl get pdb -A
kubectl describe pdb api-gateway-pdb

# Nuclear option (USE WITH CAUTION)
kubectl drain node-1 --ignore-daemonsets --delete-emptydir-data --disable-eviction
```

The `--disable-eviction` flag bypasses PDBs by deleting pods directly instead of using the Eviction API. Your users will feel this.

**Scenario 2: PDB for pods that can't reschedule**

Pod has a PDB, but also has a nodeSelector for a node type that's at capacity. Kubernetes can't evict (PDB) and can't schedule replacement (no room). Deadlock.

Fix: ensure your cluster has headroom. Run `kubectl get nodes -o custom-columns=NAME:.metadata.name,ALLOCATABLE_CPU:.status.allocatable.cpu` regularly.

**Scenario 3: PDB percentage rounding surprises**

You have 3 replicas with `maxUnavailable: 30%`. That's 0.9, which rounds down to 0. Now nothing can be evicted.

```bash
# Check actual allowed disruptions
kubectl get pdb user-service-pdb -o jsonpath='{.status.disruptionsAllowed}'
```

If this returns 0 and you're at full replica count, your percentage math is wrong.

## Implementing PDBs Without Breaking Your Deploys

Here's a practical rollout strategy:

**Step 1: Audit current state**
```bash
# Find deployments without PDBs
kubectl get deploy -A -o json | jq -r '.items[] | select(.spec.replicas > 1) | "\(.metadata.namespace)/\(.metadata.name)"' > multi-replica-deploys.txt

kubectl get pdb -A -o json | jq -r '.items[] | "\(.metadata.namespace)/\(.spec.selector.matchLabels)"' > existing-pdbs.txt

# Compare to find gaps
```

**Step 2: Start conservative**

Begin with `maxUnavailable: 1` for everything. This is almost never wrong for stateless services.

**Step 3: Add to your Helm charts/Kustomize bases**

```yaml
# In your base kustomization.yaml
resources:
  - deployment.yaml
  - service.yaml
  - pdb.yaml  # Make this mandatory
```

**Step 4: Monitor eviction failures**

```bash
# Watch for eviction issues
kubectl get events -A --field-selector reason=FailedEviction
```

Set up alerts on eviction failures. If you see them during planned maintenance windows, your PDBs might be too strict.

## Your Next Move

Open your production cluster right now and run `kubectl get pdb -A`. If that returns empty, you have work to do.

Start with your most critical service — the one that pages you at 3 AM. Add a PDB with `maxUnavailable: 1`. Deploy it. Then do the next service. Within a week, every multi-replica deployment should have a PDB.

The 6 lines of YAML cost you nothing to write and prevent the entire class of "everything got evicted at once" outages. There's no reason not to have them on every production workload today.