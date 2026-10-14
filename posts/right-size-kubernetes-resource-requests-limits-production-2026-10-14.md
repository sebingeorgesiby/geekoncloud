---
title: "Right-Size Kubernetes Resource Requests & Limits in Production"
date: 2026-10-14
excerpt: "Stop guessing CPU and memory values. Learn battle-tested methods to set Kubernetes resource requests and limits using real metrics and VPA recommendations."
tags: ["kubernetes","resource-management","cost-optimization","vpa","production"]
author: GeekOnCloud
draft: false
---

Resource requests and limits are the most misconfigured settings in production Kubernetes clusters. I've audited dozens of clusters, and the pattern is always the same: developers copy-paste values from tutorials, ops teams set arbitrary limits to "prevent runaway pods," and nobody revisits these numbers until something breaks. The result? Either you're burning money on over-provisioned containers or you're getting OOMKilled at 3 AM.

Let me show you how to actually right-size these values using production data, not guesswork.

## Why Most Teams Get This Wrong

Here's what I typically see in production manifests:

```yaml
resources:
  requests:
    memory: "512Mi"
    cpu: "500m"
  limits:
    memory: "1Gi"
    cpu: "1000m"
```

These are round numbers. That's the first red flag. Real applications don't consume exactly 512Mi of memory. These values were chosen because they looked reasonable, not because anyone measured actual usage.

The consequences:
- **Requests too high**: Nodes appear full when they're actually 30% utilized. The scheduler can't place new pods, so you scale out unnecessarily.
- **Requests too low**: Pods get scheduled on overcommitted nodes, leading to CPU throttling and evictions under pressure.
- **Limits too tight**: Your app gets OOMKilled during traffic spikes or GC pauses.
- **Limits too loose (or absent)**: A single misbehaving pod starves neighbors, causing cascading failures.

## Measuring Actual Resource Consumption

Before you can right-size anything, you need data. Not 5 minutes of data—at least 7 days, covering your peak traffic patterns.

**Option 1: Prometheus + cAdvisor (most clusters already have this)**

```bash
# Average CPU usage over 7 days for a specific deployment
avg(rate(container_cpu_usage_seconds_total{
  namespace="production",
  pod=~"api-server-.*",
  container!="POD",
  container!=""
}[7d])) by (container)

# P99 memory usage
quantile(0.99, container_memory_working_set_bytes{
  namespace="production",
  pod=~"api-server-.*",
  container!="POD",
  container!=""
}) by (container)
```

**Option 2: Kubernetes Metrics Server (lightweight, built-in)**

```bash
# Current snapshot only—not sufficient for right-sizing
kubectl top pods -n production --containers

# But useful for quick sanity checks
kubectl top pods -n production | awk 'NR>1 {print $1, $2, $3}' | sort -k2 -h
```

**Option 3: VPA in recommendation-only mode**

The Vertical Pod Autoscaler will calculate recommendations without applying them:

```yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: api-server-vpa
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-server
  updatePolicy:
    updateMode: "Off"  # Recommendations only, no automatic updates
```

After a week, check recommendations:

```bash
kubectl describe vpa api-server-vpa -n production | grep -A 20 "Recommendation"
```

## The Right-Sizing Formula

Based on your collected metrics, here's how I calculate production values:

**CPU Requests**: P50 usage + 10% buffer, rounded to nearest 50m
**CPU Limits**: P99 usage × 2, or don't set them at all (controversial, but hear me out)
**Memory Requests**: P99 usage + 15% buffer for GC headroom
**Memory Limits**: P99 usage + 25-30% buffer

Why no CPU limits? CPU is compressible—if your container exceeds its limit, it gets throttled, not killed. But CPU throttling is insidious. Your app slows down, latencies spike, but nothing shows up as an error. I've seen services with 99th percentile latencies 10x higher than expected because of throttling that nobody noticed.

Memory is different. It's incompressible. Exceed your limit, get OOMKilled. So memory limits are essential.

Here's a real example from a Node.js API server:

```yaml
# Before: guesswork values
resources:
  requests:
    memory: "512Mi"
    cpu: "500m"
  limits:
    memory: "1Gi"
    cpu: "1000m"

# After: measured values over 14 days
# P50 CPU: 127m, P99 CPU: 340m
# P50 Memory: 287Mi, P99 Memory: 412Mi
resources:
  requests:
    memory: "475Mi"   # 412Mi × 1.15
    cpu: "150m"       # 127m + 10%, rounded
  limits:
    memory: "550Mi"   # 412Mi × 1.30
    # No CPU limit—let it burst when needed
```

This change freed up 350m CPU and 450Mi memory per pod. With 12 replicas, that's over 4 CPU cores and 5Gi of memory returned to the cluster—enough to run 8 more pods.

## Handling Spiky Workloads

Some workloads don't have predictable resource patterns. Batch jobs, ML inference, anything that handles variable payloads. For these, you need a different approach.

**Use Guaranteed QoS for critical workloads:**

```yaml
# When requests == limits, pod gets Guaranteed QoS class
# These pods are last to be evicted and get dedicated resources
resources:
  requests:
    memory: "2Gi"
    cpu: "1000m"
  limits:
    memory: "2Gi"
    cpu: "1000m"
```

**Use Burstable QoS for everything else:**

```yaml
# requests < limits = Burstable QoS
# Good for most web services
resources:
  requests:
    memory: "500Mi"
    cpu: "100m"
  limits:
    memory: "1Gi"
    # No CPU limit
```

**Implement Pod Disruption Budgets alongside:**

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: api-server-pdb
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: api-server
```

## Automating Right-Sizing with Goldilocks

Manually tuning every deployment doesn't scale. Goldilocks (from Fairwinds) wraps VPA recommendations in a dashboard that shows you exactly what to change.

```bash
# Install Goldilocks
helm repo add fairwinds-stable https://charts.fairwinds.com/stable
helm install goldilocks fairwinds-stable/goldilocks --namespace goldilocks --create-namespace

# Enable for a namespace
kubectl label namespace production goldilocks.fairwinds.com/enabled=true

# Port-forward to dashboard
kubectl port-forward -n goldilocks svc/goldilocks-dashboard 8080:80
```

After 24-48 hours, you'll see recommendations like:

| Deployment | Current Request | Recommended | Savings |
|-----------|-----------------|-------------|---------|
| api-server | 500m / 512Mi | 150m / 475Mi | 70% CPU, 7% Memory |
| worker | 1000m / 2Gi | 800m / 1.2Gi | 20% CPU, 40% Memory |

Export recommendations as YAML and apply through your normal GitOps workflow.

## Continuous Right-Sizing

This isn't a one-time exercise. Application behavior changes. Traffic patterns shift. New features add memory overhead.

Build a quarterly review into your ops process:

1. Query Prometheus for all containers where `request / actual_usage > 2` (over-provisioned)
2. Query for containers with `throttling_periods > 0` in the last 7 days (under-provisioned CPU)
3. Query for containers with `oom_kills > 0` in the last 30 days (under-provisioned memory)

Here's the throttling query:

```bash
# Containers experiencing CPU throttling
sum(rate(container_cpu_cfs_throttled_periods_total{
  namespace="production",
  container!="POD"
}[7d])) by (pod, container) 
/ 
sum(rate(container_cpu_cfs_periods_total{
  namespace="production",
  container!="POD"
}[7d])) by (pod, container) > 0.1
```

Any container with >10% throttled periods needs its CPU limit raised or removed.

## Next Step

Run this command right now against your production cluster:

```bash
kubectl get pods -A -o json | jq -r '.items[] | select(.spec.containers[].resources.requests == null) | .metadata.namespace + "/" + .metadata.name'
```

That shows every pod running without resource requests. Each one is a scheduling time bomb. Start there, measure for a week, apply the formula, and work outward. You'll cut your compute bill by 20-40% while actually improving reliability.