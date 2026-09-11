---
title: "Right-Size Kubernetes Resource Requests & Limits in Production"
date: 2026-09-11
excerpt: "Stop guessing CPU and memory settings. Learn battle-tested methods to profile workloads, set accurate requests/limits, and avoid OOMKills and throttling."
tags: ["kubernetes","resource-management","cost-optimization","performance-tuning","vpa"]
author: GeekOnCloud
draft: false
---

Your Kubernetes pods are either wasting money or getting OOMKilled. There's no middle ground when you're guessing at resource requests and limits. I've seen teams burn $50K/month on over-provisioned clusters and others deal with cascading failures because one pod ate all available memory. The fix isn't complicated, but it requires actual data and a systematic approach.

## The Real Cost of Getting This Wrong

Resource requests determine scheduling. Limits determine termination. Get requests too high, and you're paying for idle capacity. Get them too low, and your scheduler packs too many pods onto nodes, leading to resource contention. Limits that are too tight cause OOMKills; too loose and one runaway pod takes down the node.

Here's what actually happens: a pod with `requests.memory: 512Mi` and `limits.memory: 1Gi` gets scheduled on a node with 2Gi available. The scheduler sees 512Mi requested, so it schedules three more similar pods. Now you have four pods that can each burst to 1Gi on a node with 2Gi. When they all spike simultaneously, the kernel's OOM killer starts terminating processes.

The metrics you need are straightforward:
- **Actual usage patterns** over at least 7 days (ideally 30)
- **Peak usage** during normal operation and during incidents
- **Startup spikes** — many JVM apps consume 2-3x steady-state memory during initialization

## Collecting the Data That Matters

Prometheus with kube-state-metrics and metrics-server gives you everything. If you're not already running these, you should be. Here's the query that actually tells you what to set:

```bash
# P99 memory usage over 7 days for a specific deployment
kubectl exec -it prometheus-server-0 -n monitoring -- \
  promtool query instant http://localhost:9090 \
  'quantile_over_time(0.99, container_memory_working_set_bytes{namespace="production", container="api-server"}[7d])'

# CPU usage pattern - this shows you the P95
curl -s "http://prometheus:9090/api/v1/query" \
  --data-urlencode 'query=quantile_over_time(0.95, rate(container_cpu_usage_seconds_total{namespace="production", container="api-server"}[5m])[7d:5m])' | jq '.data.result[].value[1]'
```

For a quick sanity check without Prometheus:

```bash
# Get current resource usage vs requests for all pods in a namespace
kubectl top pods -n production --containers | while read line; do
  pod=$(echo $line | awk '{print $1}')
  container=$(echo $line | awk '{print $2}')
  cpu=$(echo $line | awk '{print $3}')
  mem=$(echo $line | awk '{print $4}')
  
  requests=$(kubectl get pod $pod -n production -o jsonpath="{.spec.containers[?(@.name=='$container')].resources.requests}")
  echo "$pod/$container: using $cpu/$mem, requested $requests"
done
```

The Vertical Pod Autoscaler (VPA) can automate collection with its recommender component, even if you don't use it for actual scaling:

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
    updateMode: "Off"  # Just give recommendations, don't apply
  resourcePolicy:
    containerPolicies:
    - containerName: api-server
      minAllowed:
        cpu: 100m
        memory: 128Mi
      maxAllowed:
        cpu: 4
        memory: 8Gi
```

After a week, check recommendations with:

```bash
kubectl describe vpa api-server-vpa -n production | grep -A 20 "Recommendation"
```

## Setting Requests: The Math That Works

Requests should be set at **P95 of actual usage plus 10-20% headroom**. Not average. Not peak. P95 balances utilization against occasional spikes.

For a typical stateless API server I worked with recently:
- Average memory: 340Mi
- P95 memory: 420Mi  
- P99 memory: 510Mi
- Peak memory: 890Mi (during a traffic spike)

The request should be ~460-500Mi (P95 + 15%). This ensures the scheduler has accurate information for bin-packing while accommodating normal variation.

For CPU, the calculation is similar but you need to account for throttling behavior. A pod requesting 500m can only use 50ms of CPU time per 100ms period. If your app needs burst capacity, set requests lower and rely on limits (or no limits) for bursting.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-server
  namespace: production
spec:
  template:
    spec:
      containers:
      - name: api-server
        image: api-server:v2.3.1
        resources:
          requests:
            memory: "480Mi"
            cpu: "250m"
          limits:
            memory: "768Mi"
            # CPU limit intentionally omitted - see below
```

## The CPU Limits Debate: My Take

Don't set CPU limits for most workloads. Here's why: CPU is compressible. When a pod exceeds its CPU limit, it gets throttled — not killed. This throttling happens at the CFS scheduler level and causes latency spikes that are extremely hard to debug.

I've diagnosed production incidents where P99 latency would spike to 2s+ every few minutes. Root cause? CPU throttling from limits that were set "conservatively" at 2x requests. The pod would burst above the limit for a few hundred milliseconds, get throttled, and requests would pile up.

Check if you're being throttled:

```bash
# High values here mean you're losing CPU time to throttling
kubectl exec -it api-server-pod -n production -- cat /sys/fs/cgroup/cpu/cpu.stat | grep throttled
# nr_throttled 12847
# throttled_time 4839274839  # nanoseconds lost to throttling
```

Set CPU limits only when:
- You're running multi-tenant clusters and need hard isolation
- You have noisy neighbors that will starve other workloads
- Compliance requires it

For memory, **always set limits**. Memory is incompressible — there's no throttling, only termination. A memory leak will eventually take down your node if uncapped.

## The Goldilocks Approach for Production

Here's the systematic process I use:

1. **Deploy VPA in recommendation mode** for all workloads
2. **Wait 7-14 days** to capture weekly patterns
3. **Extract recommendations** and compare against current settings
4. **Apply changes during low-traffic windows** — resource changes trigger pod restarts
5. **Monitor for 48 hours** post-change for OOMKills or throttling

```bash
# Quick script to compare current vs recommended
for vpa in $(kubectl get vpa -n production -o name); do
  echo "=== $vpa ==="
  kubectl get $vpa -n production -o jsonpath='{.status.recommendation.containerRecommendations[*]}' | jq '.'
done
```

For critical workloads, add Pod Disruption Budgets before changing resources:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: api-server-pdb
  namespace: production
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: api-server
```

## Monitoring the Results

After right-sizing, track these metrics:

- **container_memory_working_set_bytes / kube_pod_container_resource_requests{resource="memory"}** — usage ratio, target 70-85%
- **kube_pod_container_status_terminated_reason{reason="OOMKilled"}** — should be zero
- **container_cpu_cfs_throttled_periods_total** — should be minimal if you removed CPU limits

Set up alerts for when usage exceeds 90% of requests sustained over 15 minutes — that's your signal to increase.

## Next Step

Run this command right now to find your worst offenders — pods requesting far more than they use:

```bash
kubectl top pods -A --containers | awk 'NR>1 {print $1, $2, $3, $4, $5}' | while read ns pod container cpu mem; do
  req_cpu=$(kubectl get pod $pod -n $ns -o jsonpath="{.spec.containers[?(@.name=='$container')].resources.requests.cpu}" 2>/dev/null)
  req_mem=$(kubectl get pod $pod -n $ns -o jsonpath="{.spec.containers[?(@.name=='$container')].resources.requests.memory}" 2>/dev/null)
  echo "$ns/$pod/$container: using $cpu/$mem, requested $req_cpu/$req_mem"
done | head -20
```

Pick the three biggest gaps and create VPAs for them today.