---
title: "Progressive Delivery: Flagger vs Argo Rollouts Deep Dive"
date: 2026-10-18
excerpt: "Compare Flagger and Argo Rollouts for canary deployments, blue-green releases, and automated rollbacks. Real configs and production patterns included."
tags: ["kubernetes","progressive-delivery","flagger","argo-rollouts","canary-deployments"]
author: GeekOnCloud
draft: false
---

You've got your Kubernetes deployments humming along, CI/CD pipeline pushing changes, and then someone asks: "What happens if that new release tanks production?" If your answer involves Slack panic and `kubectl rollout undo`, you're doing progressive delivery wrong.

Progressive delivery isn't just a buzzword—it's the difference between controlled rollouts with automatic rollback and hoping your monitoring catches problems before customers do. Two tools dominate this space: Flagger (from Flux) and Argo Rollouts (from the Argo project). Both solve the same problem with different philosophies, and I've run both in production across dozens of services. Here's what actually matters.

## The Core Problem Both Tools Solve

Traditional Kubernetes deployments are binary. You update the Deployment spec, Kubernetes starts rolling out new pods, and if something breaks, you're scrambling. Sure, you can set `maxUnavailable` and `maxSurge`, but that's not progressive delivery—that's just not deploying everything at once.

Progressive delivery introduces traffic shifting. Instead of replacing pods, you gradually shift traffic percentages from the old version to the new one while analyzing metrics. If latency spikes or error rates climb, traffic automatically shifts back. No human intervention required.

Both Flagger and Argo Rollouts implement this as Kubernetes controllers. They watch for changes to your workloads, create canary deployments, configure your service mesh or ingress to split traffic, and query your metrics backend to make promotion/rollback decisions.

## Flagger: Mesh-Native and Metric-Driven

Flagger integrates deeply with service meshes. It works with Istio, Linkerd, App Mesh, Contour, Gloo, and even nginx ingress. The core abstraction is a `Canary` CRD that wraps your Deployment.

Here's a production-ready Flagger canary config:

```yaml
apiVersion: flagger.app/v1beta1
kind: Canary
metadata:
  name: api-service
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-service
  service:
    port: 8080
    targetPort: 8080
    gateways:
      - public-gateway.istio-system.svc.cluster.local
    hosts:
      - api.example.com
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
        url: http://flagger-loadtester.test/
        timeout: 15s
        metadata:
          cmd: "hey -z 1m -q 10 -c 2 http://api-service-canary.production:8080/"
```

This configuration does the following: every minute, Flagger checks if request success rate stays above 99% and P99 latency stays under 500ms. It increments traffic by 10% each interval up to 50% before full promotion. Five consecutive failures trigger rollback.

The webhook integration is clutch—Flagger can run load tests against the canary before shifting real traffic. I've caught memory leaks this way that only manifested under load.

Flagger's strength is its metrics-first approach. It queries Prometheus (or Datadog, CloudWatch, etc.) using PromQL directly:

```yaml
apiVersion: flagger.app/v1beta1
kind: MetricTemplate
metadata:
  name: error-rate
  namespace: istio-system
spec:
  provider:
    type: prometheus
    address: http://prometheus.monitoring:9090
  query: |
    100 - sum(
      rate(istio_requests_total{
        reporter="destination",
        destination_workload_namespace="{{ namespace }}",
        destination_workload="{{ target }}",
        response_code!~"5.*"
      }[{{ interval }}])
    ) / sum(
      rate(istio_requests_total{
        reporter="destination",
        destination_workload_namespace="{{ namespace }}",
        destination_workload="{{ target }}"
      }[{{ interval }}])
    ) * 100
```

You write the exact query that matters for your service. No magic, no abstraction—just PromQL.

## Argo Rollouts: Flexible and Analysis-Driven

Argo Rollouts takes a different approach. Instead of wrapping Deployments, you replace them with a `Rollout` resource. Same pod spec, different controller.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: api-service
spec:
  replicas: 5
  strategy:
    canary:
      canaryService: api-service-canary
      stableService: api-service-stable
      trafficRouting:
        istio:
          virtualService:
            name: api-service-vsvc
            routes:
              - primary
      steps:
        - setWeight: 10
        - pause: {duration: 2m}
        - setWeight: 30
        - pause: {duration: 2m}
        - analysis:
            templates:
              - templateName: success-rate
            args:
              - name: service-name
                value: api-service-canary
        - setWeight: 50
        - pause: {duration: 5m}
        - setWeight: 100
  selector:
    matchLabels:
      app: api-service
  template:
    metadata:
      labels:
        app: api-service
    spec:
      containers:
        - name: api
          image: api-service:v2.1.0
          ports:
            - containerPort: 8080
```

Notice the explicit steps. Argo Rollouts gives you a declarative pipeline: set weight, pause, run analysis, continue. This is more readable than Flagger's interval-based approach and lets you insert manual approval gates:

```yaml
steps:
  - setWeight: 20
  - pause: {}  # indefinite pause, requires manual promotion
```

The `AnalysisTemplate` is where you define success criteria:

```yaml
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
      successCondition: result[0] >= 0.95
      failureLimit: 3
      provider:
        prometheus:
          address: http://prometheus.monitoring:9090
          query: |
            sum(rate(http_requests_total{service="{{args.service-name}}", status=~"2.."}[5m])) 
            / 
            sum(rate(http_requests_total{service="{{args.service-name}}"}[5m]))
```

Argo Rollouts also supports blue-green deployments natively, not just canary. If your service can't handle traffic splitting (stateful workloads, certain databases), blue-green with instant cutover is cleaner.

## Head-to-Head: When to Use Which

**Choose Flagger when:**
- You're already invested in the Flux ecosystem
- You want Deployments to remain standard (Flagger wraps, doesn't replace)
- Your team prefers metric-first configuration over step-based pipelines
- You need tight Linkerd integration (Flagger's Linkerd support is excellent)

**Choose Argo Rollouts when:**
- You're using Argo CD for GitOps (they integrate beautifully)
- You want explicit step-based rollout visualization in a UI
- You need blue-green deployments alongside canary
- Manual approval gates are a requirement

Performance-wise, both add minimal overhead. The controllers watch resources and make API calls—we're talking single-digit millisecond latencies for traffic shifting decisions. I've run both with 200+ services without controller scaling issues.

## Production Gotchas Nobody Tells You

**Metric lag kills rollbacks.** If your Prometheus scrape interval is 30 seconds and your analysis interval is 1 minute, you might shift traffic twice before bad metrics even appear. Set `interval` in your analysis to at least 3x your scrape interval.

**Session affinity breaks canary analysis.** If users stick to one backend for their session, your canary might only see a subset of user behavior. Either disable affinity during rollouts or ensure your canary gets statistically significant traffic.

**Both tools need traffic.** If your service gets 10 requests per minute, statistical analysis is meaningless. Configure minimum request thresholds or use synthetic load testing (Flagger's webhook approach or Argo's `AnalysisRun` with a Job).

**Observability gaps cause false positives.** If your success rate metric doesn't exist for a new service (no traffic yet), both tools will fail analysis. Pre-populate metrics or configure `count` requirements in your analysis.

## Get Started in 30 Minutes

Install Flagger with Helm:

```bash
helm repo add flagger https://flagger.app
helm upgrade -i flagger flagger/flagger \
  --namespace=istio-system \
  --set meshProvider=istio \
  --set metricsServer=http://prometheus.monitoring:9090
```

Or Argo Rollouts:

```bash
kubectl create namespace argo-rollouts
kubectl apply -n argo-rollouts -f https://github.com/argoproj/argo-rollouts/releases/latest/download/install.yaml
kubectl apply -f https://github.com/argoproj/argo-rollouts/releases/latest/download/dashboard-install.yaml
```

Pick one service—something with traffic, metrics, and tolerance for experimentation. Convert its Deployment to a Canary or Rollout resource. Set conservative thresholds (95% success rate, 1000ms latency). Push a change and watch traffic shift.

Your next deploy shouldn't require crossed fingers. Make the machines watch the metrics.