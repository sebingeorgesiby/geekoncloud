---
title: Zero-downtime Kubernetes deployments with Argo Rollouts
date: 2025-04-20
excerpt: Stop using RollingUpdate and start using progressive delivery. A practical guide to canary and blue/green deployments with Argo Rollouts on any Kubernetes cluster.
tags: ["Kubernetes", "GitOps", "CI/CD"]
author: GeekOnCloud
draft: false
---

## Why rolling updates aren't enough

Kubernetes `RollingUpdate` is fine for development. For production, it's a liability. There's no traffic shifting, no automatic rollback on error-rate spikes, and no way to expose a new version to 5% of traffic while keeping 95% on the stable release.

Argo Rollouts solves this cleanly.

## What is Argo Rollouts?

Argo Rollouts is a Kubernetes controller that extends the native deployment model with:

- **Canary deployments** — shift traffic progressively (5% → 25% → 100%) with automated analysis
- **Blue/green deployments** — run two parallel environments, switch instantly
- **Analysis runs** — gate promotions behind Prometheus metrics, Datadog, or custom webhooks

## Installation

```bash
kubectl create namespace argo-rollouts
kubectl apply -n argo-rollouts -f https://github.com/argoproj/argo-rollouts/releases/latest/download/install.yaml
```

Install the CLI:

```bash
brew install argoproj/tap/kubectl-argo-rollouts
```

## A canary Rollout manifest

Replace your `Deployment` with a `Rollout`:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: api-server
spec:
  replicas: 10
  selector:
    matchLabels:
      app: api-server
  template:
    metadata:
      labels:
        app: api-server
    spec:
      containers:
        - name: api-server
          image: ghcr.io/myorg/api-server:v2.1.0
          ports:
            - containerPort: 8080
  strategy:
    canary:
      steps:
        - setWeight: 5
        - pause: {duration: 5m}
        - setWeight: 25
        - pause: {duration: 10m}
        - analysis:
            templates:
              - templateName: success-rate
        - setWeight: 100
```

## Automatic rollback with Analysis

Create an `AnalysisTemplate` that queries Prometheus:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: success-rate
spec:
  metrics:
    - name: success-rate
      interval: 2m
      successCondition: result[0] >= 0.95
      failureLimit: 3
      provider:
        prometheus:
          address: http://prometheus:9090
          query: |
            sum(rate(http_requests_total{job="api-server",status=~"2.."}[5m]))
            /
            sum(rate(http_requests_total{job="api-server"}[5m]))
```

If the success rate drops below 95% three times in a row, Argo Rollouts automatically promotes back to the stable version.

## Monitoring your rollout

```bash
kubectl argo rollouts get rollout api-server --watch
```

You'll see a live dashboard in your terminal showing traffic weight, pod counts, and analysis run status.

## Integrating with GitOps (Argo CD)

If you're using Argo CD, install the [argo-cd-rollouts plugin](https://argo-cd.readthedocs.io) and your rollouts show up directly in the Argo CD UI with promote/abort controls.

## Conclusion

Argo Rollouts takes about 30 minutes to install and configure. The payoff is production deployments you can actually control — progressive traffic shifts, automated rollback, and full observability. There's no reason to run raw `RollingUpdate` in production once you've tried it.
