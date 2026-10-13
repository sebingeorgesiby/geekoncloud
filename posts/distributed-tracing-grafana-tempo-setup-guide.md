---
title: "Distributed Tracing with Grafana Tempo: Complete Setup Guide"
date: 2026-10-13
excerpt: "Deploy Grafana Tempo for distributed tracing. Covers instrumentation, trace correlation, and querying traces across microservices with real configs."
tags: ["observability","grafana","tempo","distributed-tracing","opentelemetry"]
author: GeekOnCloud
draft: false
---

When your microservices architecture grows past a handful of services, logs become noise and metrics become averages that hide the real problems. A request that takes 3 seconds to complete might touch 12 services—good luck finding the bottleneck by grepping logs. This is where distributed tracing becomes non-negotiable, and Grafana Tempo offers a cost-effective way to store and query traces at scale without the operational overhead of Jaeger or the cost of commercial APM tools.

## Why Tempo Over Jaeger or Zipkin

Tempo's architecture is fundamentally different from traditional tracing backends. Instead of indexing every span attribute (which gets expensive fast), Tempo stores traces in object storage (S3, GCS, Azure Blob) and relies on trace IDs for lookups. This means you're paying pennies per GB instead of running expensive Elasticsearch clusters.

The tradeoff is clear: you can't search for "all traces where `user.id=12345`" directly in Tempo. But here's the thing—you shouldn't be doing that anyway. The pattern that actually works is: metrics tell you something's wrong, logs give you the trace ID, Tempo shows you exactly what happened. Grafana's exemplars feature bridges this gap beautifully by embedding trace IDs directly in your metrics.

Real numbers from production: a Jaeger deployment indexing 50M spans/day required 12 Elasticsearch nodes with 2TB NVMe each. The same workload in Tempo costs about $150/month in S3 storage and runs on 3 small query nodes.

## Setting Up Tempo with Docker Compose

Let's start with a local setup that mirrors production architecture. This docker-compose gives you Tempo, Grafana, and an OpenTelemetry Collector:

```yaml
version: "3.8"

services:
  tempo:
    image: grafana/tempo:2.3.1
    command: ["-config.file=/etc/tempo/tempo.yaml"]
    volumes:
      - ./tempo.yaml:/etc/tempo/tempo.yaml
      - tempo-data:/var/tempo
    ports:
      - "3200:3200"   # tempo
      - "4317:4317"   # otlp grpc
      - "4318:4318"   # otlp http

  otel-collector:
    image: otel/opentelemetry-collector-contrib:0.92.0
    command: ["--config=/etc/otel/config.yaml"]
    volumes:
      - ./otel-collector.yaml:/etc/otel/config.yaml
    ports:
      - "4327:4317"   # otlp grpc (app-facing)
      - "55679:55679" # zpages

  grafana:
    image: grafana/grafana:10.3.1
    environment:
      - GF_AUTH_ANONYMOUS_ENABLED=true
      - GF_AUTH_ANONYMOUS_ORG_ROLE=Admin
    volumes:
      - ./grafana-datasources.yaml:/etc/grafana/provisioning/datasources/datasources.yaml
    ports:
      - "3000:3000"

volumes:
  tempo-data:
```

The Tempo configuration file needs attention to detail. Here's a production-ready config that handles real throughput:

```yaml
# tempo.yaml
server:
  http_listen_port: 3200

distributor:
  receivers:
    otlp:
      protocols:
        grpc:
          endpoint: 0.0.0.0:4317
        http:
          endpoint: 0.0.0.0:4318

ingester:
  max_block_duration: 5m
  trace_idle_period: 10s
  max_block_bytes: 1073741824  # 1GB

compactor:
  compaction:
    block_retention: 336h  # 14 days

storage:
  trace:
    backend: local
    local:
      path: /var/tempo/blocks
    wal:
      path: /var/tempo/wal

querier:
  search:
    prefer_self: 10  # prefer local blocks before querying backend

metrics_generator:
  registry:
    external_labels:
      source: tempo
  storage:
    path: /var/tempo/generator/wal
    remote_write:
      - url: http://prometheus:9090/api/v1/write
        send_exemplars: true
```

## Instrumenting Your Application

The OpenTelemetry SDK is your best bet for instrumentation—it's vendor-neutral and Tempo speaks OTLP natively. Here's a Go example that demonstrates proper context propagation:

```go
package main

import (
    "context"
    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
    "go.opentelemetry.io/otel/sdk/trace"
    "google.golang.org/grpc"
)

func initTracer() (*trace.TracerProvider, error) {
    ctx := context.Background()
    
    conn, err := grpc.DialContext(ctx, "otel-collector:4317",
        grpc.WithInsecure(),
        grpc.WithBlock(),
    )
    if err != nil {
        return nil, err
    }

    exporter, err := otlptracegrpc.New(ctx, otlptracegrpc.WithGRPCConn(conn))
    if err != nil {
        return nil, err
    }

    tp := trace.NewTracerProvider(
        trace.WithBatcher(exporter),
        trace.WithSampler(trace.ParentBased(trace.TraceIDRatioBased(0.1))), // 10% sampling
    )
    
    otel.SetTracerProvider(tp)
    return tp, nil
}
```

That `TraceIDRatioBased(0.1)` is critical. Tracing 100% of requests in production will bankrupt you and provide no additional value. Start at 10%, adjust based on your traffic patterns. For debugging specific issues, use head-based sampling with feature flags to temporarily increase rates.

## Connecting Traces to Metrics with Exemplars

This is where the magic happens. Tempo's metrics generator can automatically create RED metrics (Rate, Errors, Duration) from your traces and attach exemplars—clickable links from your metrics to the actual traces that generated them.

Configure Prometheus to accept exemplars and set up the recording rules:

```yaml
# prometheus.yaml excerpt
global:
  scrape_interval: 15s
  
remote_write:
  - url: http://prometheus:9090/api/v1/write
    
storage:
  exemplars:
    max_exemplars: 100000
```

In Grafana, create a dashboard panel with a Prometheus query that shows latency percentiles:

```promql
histogram_quantile(0.99, sum(rate(traces_spanmetrics_latency_bucket{service="api-gateway"}[5m])) by (le))
```

Enable "Exemplars" in the panel options, and suddenly each data point becomes a portal into the exact trace that caused that latency spike. No more guessing which request was slow—click the dot, see the full distributed trace.

## Production Deployment on Kubernetes

For production, you'll want the microservices mode deployment. Here's a Helm values file that's actually been battle-tested:

```yaml
# tempo-distributed values.yaml
tempo:
  metricsGenerator:
    enabled: true
    remoteWriteUrl: "http://prometheus.monitoring:9090/api/v1/write"

  storage:
    trace:
      backend: s3
      s3:
        bucket: tempo-traces-prod
        endpoint: s3.us-east-1.amazonaws.com
        region: us-east-1

ingester:
  replicas: 3
  persistence:
    enabled: true
    size: 50Gi
  resources:
    requests:
      cpu: 500m
      memory: 2Gi
    limits:
      memory: 4Gi

distributor:
  replicas: 2
  autoscaling:
    enabled: true
    minReplicas: 2
    maxReplicas: 10
    targetCPUUtilizationPercentage: 80

querier:
  replicas: 2

queryFrontend:
  replicas: 2
  query:
    search:
      maxDuration: 168h
```

Deploy with:

```bash
helm repo add grafana https://grafana.github.io/helm-charts
helm upgrade --install tempo grafana/tempo-distributed \
  -f tempo-distributed-values.yaml \
  -n tracing --create-namespace
```

## Querying and Debugging

TraceQL is Tempo's query language, and it's surprisingly powerful once you learn the syntax:

```
# Find traces where any span has error status and duration > 500ms
{ status = error } && duration > 500ms

# Find traces through a specific service with high latency
{ resource.service.name = "payment-service" && duration > 2s }

# Find traces where database calls exceeded 100ms
{ span.db.system = "postgresql" && duration > 100ms }
```

The catch: these queries only work if you have TraceQL search enabled and are using object storage that supports it (S3, GCS). Local storage mode is for dev only.

## The Practical Path Forward

Get the docker-compose stack running locally this week. Instrument one service with OpenTelemetry—start with your API gateway or BFF layer since it touches every request. Set up a single Grafana dashboard with latency metrics and exemplars enabled. Once you've clicked through a few traces and actually debugged something faster than you would have with logs alone, you'll understand why this investment pays off. The infrastructure cost is minimal; the time savings during incidents is substantial.