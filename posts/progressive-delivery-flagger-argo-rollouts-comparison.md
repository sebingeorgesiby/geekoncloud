---
title: "Progressive Delivery: Flagger vs Argo Rollouts Deep Dive"
date: 2026-09-15
excerpt: "Compare Flagger and Argo Rollouts for canary deployments, blue-green releases, and automated rollbacks. Real configs and metrics integration included."
tags: ["kubernetes","progressive-delivery","flagger","argo-rollouts","canary-deployments"]
author: GeekOnCloud
draft: false
---

Progressive delivery isn't just a fancy term for "deploy slowly." It's the difference between finding out your service is broken from PagerDuty at 3 AM versus catching it during a controlled 5% traffic test. Both Flagger and Argo Rollouts solve this problem, but they approach it from fundamentally different angles. After running both in production across multiple clusters, here's what actually matters when choosing between them.

## The Core Philosophy Difference

Argo Rollouts extends the Kubernetes Deployment resource. You replace your Deployment with a Rollout, configure your strategy, and you're off. It's opinionated about being a GitOps-native tool, integrating tightly with Argo CD.

Flagger takes a different approach — it watches your existing Deployments and creates the progressive delivery infrastructure around them. Your Deployment stays a Deployment. Flagger generates the canary Deployment, services, and traffic routing automatically.

This matters more than it sounds. With Argo Rollouts, your application manifests change. Your CI/CD pipelines need to understand Rollout resources. With Flagger, your existing tooling keeps working — Flagger operates as a layer on top.

## Setting Up Flagger with Istio

Flagger supports multiple service meshes and ingress controllers. Here's a production-ready Flagger installation with Istio:

```yaml
apiVersion: flagger.app/v1beta1
kind: Canary
metadata:
  name: api-gateway
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-gateway
  progressDeadlineSeconds: 600
  service:
    port: 8080
    targetPort: 8080
    gateways:
      - public-gateway.istio-system.svc.cluster.local
    hosts:
      - api.yourcompany.com
    trafficPolicy:
      tls:
        mode: ISTIO_MUTUAL
  analysis:
    interval: 1m
    threshold: 5
    maxWeight: 50
    stepWeight: 10
    metrics:
      - name: request-success-rate
        thresholdRange:
          min: 99
        interval: 1m
      - name: request-duration
        thresholdRange:
          max: 500
        interval: 1m
    webhooks:
      - name: load-test
        type: rollout
        url: http://flagger-loadtester.test/
        timeout: 15s
        metadata:
          type: cmd
          cmd: "hey -z 1m -q 10 -c 2 http://api-gateway-canary.production:8080/"
```

This configuration does several things: it starts the canary at 0% traffic, increments by 10% every minute if metrics pass, rolls back after 5 consecutive failures, and maxes out at 50% before promoting. The `request-success-rate` metric requires 99%+ success rate, and `request-duration` caps P99 latency at 500ms.

The load test webhook is critical — without synthetic traffic during low-traffic periods, you won't have enough samples to make statistically valid decisions.

## Argo Rollouts with Analysis Templates

Argo Rollouts bakes analysis directly into the rollout strategy. Here's an equivalent setup:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: api-gateway
  namespace: production
spec:
  replicas: 10
  strategy:
    canary:
      canaryService: api-gateway-canary
      stableService: api-gateway-stable
      trafficRouting:
        istio:
          virtualService:
            name: api-gateway-vsvc
            routes:
              - primary
      steps:
        - setWeight: 10
        - pause: {duration: 2m}
        - analysis:
            templates:
              - templateName: success-rate
            args:
              - name: service-name
                value: api-gateway-canary
        - setWeight: 30
        - pause: {duration: 2m}
        - analysis:
            templates:
              - templateName: success-rate
        - setWeight: 50
        - pause: {duration: 5m}
        - analysis:
            templates:
              - templateName: latency-check
  selector:
    matchLabels:
      app: api-gateway
  template:
    metadata:
      labels:
        app: api-gateway
    spec:
      containers:
        - name: api-gateway
          image: api-gateway:v2.1.0
          ports:
            - containerPort: 8080
---
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: success-rate
spec:
  args:
    - name: service-name
  metrics:
    - name: success-rate
      interval: 1m
      successCondition: result[0] >= 0.99
      failureLimit: 3
      provider:
        prometheus:
          address: http://prometheus.monitoring:9090
          query: |
            sum(rate(istio_requests_total{
              destination_service_name="{{args.service-name}}",
              response_code!~"5.*"
            }[2m])) /
            sum(rate(istio_requests_total{
              destination_service_name="{{args.service-name}}"
            }[2m]))
```

Notice the difference in control granularity. Argo Rollouts lets you define explicit steps with different pause durations and analysis runs at specific points. You can run a basic analysis at 10%, a comprehensive analysis at 30%, and a soak test at 50%. Flagger's analysis runs continuously — simpler, but less flexible.

## Real-World Performance Considerations

In practice, both tools add minimal overhead to the data plane — traffic routing happens through your existing service mesh. The control plane impact differs though.

Flagger polls your Deployments and metrics every analysis interval (default 1 minute). With 50 Canary resources, expect roughly 50 Prometheus queries per minute plus the reconciliation overhead. We've run 200+ Canaries on a single Flagger instance without issues.

Argo Rollouts creates more Kubernetes resources — ReplicaSets for canary and stable, plus AnalysisRuns for each analysis execution. At scale, this means more etcd load and more garbage collection of completed AnalysisRuns. Set `spec.analysis.successfulRunHistoryLimit` and `spec.analysis.unsuccessfulRunHistoryLimit` to avoid accumulating thousands of completed runs.

Both tools need proper Prometheus retention. Your queries span the analysis window, so if you're doing 5-minute analysis intervals with 2-minute rate windows, you need at least 10 minutes of retention for accuracy. In practice, keep 24 hours minimum for debugging failed rollouts.

## The Decision Framework

Choose Flagger when:
- You have existing Deployments and don't want to change resource types
- You're running multiple service meshes across clusters (Flagger's abstraction helps)
- Your team manages applications separately from the progressive delivery configuration

Choose Argo Rollouts when:
- You're already invested in Argo CD and want tight integration
- You need complex rollout steps (blue-green to canary hybrids, header-based routing)
- You want analysis at specific rollout phases rather than continuous

Both tools support the same metrics providers, same service meshes, and both can trigger webhooks for notifications or approvals. The workflow differences matter more than feature checklists.

One pattern we've adopted: use Argo Rollouts for stateless API services where precise traffic stepping matters, and Flagger for internal services where continuous analysis with automatic progression works fine. The tools coexist without conflict.

## What To Build Next

Start with a single service. Pick something non-critical that has good Prometheus metrics — you need at least request rate and error rate. Deploy Flagger or Argo Rollouts, configure a basic success-rate analysis, and deliberately deploy a broken version. Watch the automatic rollback trigger. That failure mode is the entire point of progressive delivery — see it work before you trust it with production traffic.