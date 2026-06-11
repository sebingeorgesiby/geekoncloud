---
title: "Kubernetes HPA vs VPA vs KEDA: Which Autoscaler to Use"
date: 2026-06-11
excerpt: "Compare HPA, VPA, and KEDA with real configs and benchmarks. Learn when each Kubernetes autoscaler wins and how to combine them effectively."
tags: ["kubernetes","autoscaling","hpa","vpa","keda","devops"]
author: GeekOnCloud
draft: false
---

You've deployed your first Kubernetes application, it's running fine with 3 replicas, and now someone asks: "How does it scale?" This is where most engineers reach for HPA because it's what the tutorials show. But HPA is just one tool in a toolkit that includes VPA and KEDA—each solving fundamentally different scaling problems. Pick wrong, and you'll either burn money on over-provisioned pods or watch your application crumble under load.

Let me break down when to use each, with real configs you can deploy today.

## HPA: The Horizontal Workhorse

Horizontal Pod Autoscaler does one thing: adds or removes pod replicas based on metrics. It's been around since Kubernetes 1.1 and remains the default choice for stateless workloads with predictable scaling patterns.

Here's a production-ready HPA config for a typical web service:

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: api-server-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-server
  minReplicas: 3
  maxReplicas: 50
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: 80
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
      - type: Percent
        value: 10
        periodSeconds: 60
    scaleUp:
      stabilizationWindowSeconds: 0
      policies:
      - type: Percent
        value: 100
        periodSeconds: 15
      - type: Pods
        value: 4
        periodSeconds: 15
      selectPolicy: Max
```

The `behavior` block is critical and often ignored. Without it, HPA will thrash—scaling up and down rapidly as metrics oscillate. The config above scales up aggressively (double capacity every 15 seconds if needed) but scales down conservatively (max 10% reduction per minute, with a 5-minute stabilization window).

HPA works best when:
- Your application is stateless
- Each replica handles roughly equal load
- Startup time is under 30 seconds
- You're scaling on CPU or memory (or custom metrics via Prometheus Adapter)

HPA fails when your pods take 5 minutes to warm up JIT caches, or when your workload is event-driven rather than request-driven.

## VPA: Right-Sizing Your Requests

Vertical Pod Autoscaler solves a different problem entirely: figuring out what resource requests your pods actually need. Most teams set CPU/memory requests by guessing, then never adjust them. VPA watches actual usage and recommends (or automatically applies) right-sized requests.

Install VPA with:

```bash
git clone https://github.com/kubernetes/autoscaler.git
cd autoscaler/vertical-pod-autoscaler
./hack/vpa-up.sh
```

Then create a VPA policy:

```yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: api-server-vpa
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-server
  updatePolicy:
    updateMode: "Auto"
  resourcePolicy:
    containerPolicies:
    - containerName: "*"
      minAllowed:
        cpu: 100m
        memory: 128Mi
      maxAllowed:
        cpu: 4
        memory: 8Gi
      controlledResources: ["cpu", "memory"]
```

The `updateMode` has three options:
- `Off`: VPA only provides recommendations (check with `kubectl describe vpa api-server-vpa`)
- `Initial`: Sets resources only at pod creation
- `Auto`: Evicts and recreates pods when adjustments are needed

That eviction behavior is VPA's Achilles heel. It can't resize running pods—it must kill them to apply new resource values. For this reason, start with `updateMode: "Off"` in production, review recommendations for a week, then decide if automatic updates make sense for your risk tolerance.

VPA shines for:
- Batch jobs where resource needs vary per execution
- Long-running services where you want to stop guessing at requests
- Reducing cluster costs by eliminating over-provisioning

**Critical caveat**: Don't run VPA in Auto mode alongside HPA on the same CPU/memory metrics. They'll fight. VPA increases pod resources, utilization drops, HPA removes replicas, utilization spikes, repeat. Use HPA for scaling replica count on custom metrics while VPA handles resource requests, or pick one.

## KEDA: Event-Driven Scaling to Zero

Kubernetes Event-Driven Autoscaling is what you reach for when HPA's metric polling model doesn't fit. KEDA scales based on event sources: Kafka topic lag, RabbitMQ queue depth, AWS SQS messages, Prometheus queries, cron schedules—60+ scalers and counting.

The killer feature? KEDA scales to zero replicas and back. HPA's minimum is 1.

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: order-processor
spec:
  scaleTargetRef:
    name: order-processor
  minReplicaCount: 0
  maxReplicaCount: 100
  cooldownPeriod: 300
  pollingInterval: 15
  triggers:
  - type: kafka
    metadata:
      bootstrapServers: kafka.prod.svc:9092
      consumerGroup: order-processors
      topic: orders
      lagThreshold: "100"
  - type: prometheus
    metadata:
      serverAddress: http://prometheus.monitoring:9090
      metricName: http_requests_pending
      threshold: "50"
      query: sum(http_requests_pending{service="order-api"})
```

This config keeps zero replicas running until either Kafka lag exceeds 100 messages or pending HTTP requests exceed 50. Once triggered, KEDA activates the deployment and hands off to an HPA it creates automatically. When the queue drains and metrics drop, replicas scale back to zero.

For queue-based workloads, KEDA's lag-based scaling is transformative. Instead of scaling on CPU (a trailing indicator), you're scaling on queue depth (a leading indicator). Your consumers spin up *before* they're overwhelmed.

Install KEDA via Helm:

```bash
helm repo add kedacore https://kedacore.github.io/charts
helm install keda kedacore/keda --namespace keda --create-namespace
```

KEDA is the right choice when:
- Workloads are triggered by external events (queues, topics, webhooks)
- You need scale-to-zero for cost savings
- HPA's 15-second metric scraping is too slow
- You're running batch processors, webhook handlers, or event consumers

## Combining Autoscalers: A Real Architecture

Here's how these tools fit together in a production e-commerce platform:

**Web Frontend (HPA)**: Stateless Next.js pods scaling 3-20 replicas on CPU. HPA with aggressive scale-up, conservative scale-down. Startup time is 8 seconds—fast enough for reactive scaling.

**API Gateway (HPA + VPA in Off mode)**: Go services scaling 5-100 replicas on custom `requests_per_second` metric via Prometheus Adapter. VPA runs in recommendation mode, feeding weekly capacity reviews.

**Order Processor (KEDA)**: Python workers consuming from SQS. Scales 0-50 based on `ApproximateNumberOfMessages`. Saves ~$800/month by not running idle consumers overnight.

**ML Inference (VPA in Auto mode)**: Single replica, GPU-attached, traffic is spiky but not predictable. VPA adjusts memory requests as model sizes change. HPA disabled—can't horizontally scale a model that requires 16GB VRAM.

## Decision Framework

Ask these questions in order:

1. **Does it need to scale to zero?** → KEDA
2. **Is scaling triggered by events/queues rather than load?** → KEDA
3. **Is it stateless with fast startup?** → HPA
4. **Are you unsure what resources it actually needs?** → VPA (Off mode first)
5. **Is it a singleton that needs vertical growth?** → VPA (Auto mode)

The default answer isn't always HPA. I've seen teams run HPA on Kafka consumers, scaling on CPU, watching replicas thrash while lag grows unbounded. Switching to KEDA with lag-based scaling fixed it in one deploy.

## Your Next Move

Run `kubectl top pods` right now on your production namespace. Find the pod with the biggest gap between requested and actual CPU/memory. That's your first VPA candidate. Deploy it in `Off` mode, wait 48 hours, check the recommendations. You'll likely find 30-40% of your requested resources are wasted.

That's free money. Go get it.