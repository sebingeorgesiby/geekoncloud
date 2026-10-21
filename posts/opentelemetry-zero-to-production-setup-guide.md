---
title: "OpenTelemetry Setup Guide: Zero to Production in 2024"
date: 2026-10-21
excerpt: "Deploy OpenTelemetry end-to-end: auto-instrumentation, collectors, sampling strategies, and Grafana integration. Real configs included."
tags: ["opentelemetry","observability","distributed-tracing","grafana","kubernetes"]
author: GeekOnCloud
draft: false
---

You've deployed your microservices, traffic is flowing, and then a user reports "the checkout is slow." You SSH into boxes, grep through logs, correlate timestamps manually, and two hours later discover a downstream payment service was timing out. This is the observability gap that OpenTelemetry closes. After implementing OTel across three production environments—handling everything from a 50-service e-commerce platform to a real-time analytics pipeline—I'll walk you through the exact setup that gets you from zero instrumentation to production-grade observability.

## Why OpenTelemetry, and Why Now

OpenTelemetry isn't just another monitoring tool—it's a vendor-neutral standard that unifies traces, metrics, and logs under one SDK. Before OTel, you'd have Jaeger for tracing, Prometheus for metrics, Fluentd for logs, each with separate instrumentation. Change your backend? Rewrite everything.

The practical win: instrument once, export anywhere. Your code stays clean, and switching from Jaeger to Tempo or from Prometheus to Datadog becomes a configuration change, not a rewrite. The CNCF graduated OTel in 2024, meaning it's production-stable and here to stay.

The ecosystem has matured significantly. Auto-instrumentation covers most common frameworks out of the box—Express, Flask, Spring Boot, gRPC—meaning you get 80% of trace coverage with zero code changes.

## The Collector: Your Telemetry Pipeline's Core

Skip deploying the SDK exporters directly to backends. The OpenTelemetry Collector acts as your telemetry router—receiving data from applications, processing it, and exporting to multiple destinations. This architecture gives you buffering, retry logic, and the ability to sample or transform data before it hits your storage.

Here's a production-ready collector configuration:

```yaml
# otel-collector-config.yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318
  prometheus:
    config:
      scrape_configs:
        - job_name: 'kubernetes-pods'
          kubernetes_sd_configs:
            - role: pod
          relabel_configs:
            - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_scrape]
              action: keep
              regex: true

processors:
  batch:
    timeout: 5s
    send_batch_size: 1000
  memory_limiter:
    check_interval: 1s
    limit_mib: 1800
    spike_limit_mib: 500
  tail_sampling:
    decision_wait: 10s
    policies:
      - name: errors-policy
        type: status_code
        status_code: {status_codes: [ERROR]}
      - name: slow-traces
        type: latency
        latency: {threshold_ms: 1000}
      - name: probabilistic-sample
        type: probabilistic
        probabilistic: {sampling_percentage: 10}

exporters:
  otlp/tempo:
    endpoint: tempo.monitoring.svc.cluster.local:4317
    tls:
      insecure: true
  prometheusremotewrite:
    endpoint: http://mimir.monitoring.svc.cluster.local:9009/api/v1/push
  loki:
    endpoint: http://loki.monitoring.svc.cluster.local:3100/loki/api/v1/push

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, tail_sampling, batch]
      exporters: [otlp/tempo]
    metrics:
      receivers: [otlp, prometheus]
      processors: [memory_limiter, batch]
      exporters: [prometheusremotewrite]
    logs:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [loki]
```

The `tail_sampling` processor is crucial for production. Without it, you're either storing everything (expensive) or randomly sampling (missing errors). This config keeps all errors, all slow traces over 1 second, and 10% of everything else—typically reducing storage costs by 70-80% while keeping the data that matters.

## Application Instrumentation: The SDK Setup

For a Node.js service, here's the minimal bootstrap that gets auto-instrumentation working:

```javascript
// tracing.js - require this BEFORE your app code
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-grpc');
const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-grpc');
const { PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
const { Resource } = require('@opentelemetry/resources');
const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions');

const sdk = new NodeSDK({
  resource: new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || 'my-service',
    [SemanticResourceAttributes.SERVICE_VERSION]: process.env.APP_VERSION || '1.0.0',
    [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: process.env.NODE_ENV || 'development',
  }),
  traceExporter: new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://otel-collector:4317',
  }),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({
      url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://otel-collector:4317',
    }),
    exportIntervalMillis: 15000,
  }),
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-fs': { enabled: false }, // noisy, disable
      '@opentelemetry/instrumentation-http': {
        ignoreIncomingPaths: ['/health', '/ready', '/metrics'],
      },
    }),
  ],
});

sdk.start();

process.on('SIGTERM', () => {
  sdk.shutdown()
    .then(() => console.log('Tracing shut down'))
    .catch((error) => console.error('Error shutting down tracing', error))
    .finally(() => process.exit(0));
});
```

Then in your Dockerfile or entrypoint: `node --require ./tracing.js app.js`. That's it—HTTP calls, database queries, and framework operations now generate traces automatically.

For Python (Flask/FastAPI), the approach is similar but uses `opentelemetry-instrument` CLI. For Go, you'll need explicit instrumentation with `otel.Tracer`, but the collector config remains identical.

## Kubernetes Deployment: The Operator Approach

Manual collector deployments work, but the OpenTelemetry Operator handles lifecycle management, auto-instrumentation injection, and collector scaling. Install it via Helm:

```bash
helm repo add open-telemetry https://open-telemetry.github.io/opentelemetry-helm-charts
helm install opentelemetry-operator open-telemetry/opentelemetry-operator \
  --namespace opentelemetry \
  --create-namespace \
  --set admissionWebhooks.certManager.enabled=true \
  --set manager.collectorImage.repository=otel/opentelemetry-collector-contrib
```

Now deploy your collector as a custom resource:

```yaml
apiVersion: opentelemetry.io/v1beta1
kind: OpenTelemetryCollector
metadata:
  name: otel
  namespace: opentelemetry
spec:
  mode: daemonset  # or deployment for gateway pattern
  config:
    # paste your collector config here
```

The operator also enables auto-instrumentation injection—annotate a namespace or deployment with `instrumentation.opentelemetry.io/inject-nodejs: "true"` and pods get instrumented without touching application code.

## Production Hardening: What Actually Breaks

After running OTel in production, here's what catches teams:

**Memory pressure**: The collector can buffer significant data. That `memory_limiter` processor isn't optional—without it, a downstream outage fills collector memory until it OOMs. Set `limit_mib` to 80% of your container's memory limit.

**Cardinality explosions**: Custom metrics with high-cardinality labels (user IDs, request IDs) will destroy your metrics backend. Use the `filter` processor to drop or aggregate these.

**Context propagation**: Traces break at service boundaries if you're not propagating the right headers. Ensure `traceparent` and `tracestate` (W3C Trace Context) headers flow through your API gateways, message queues, and async jobs.

**Collector placement**: In Kubernetes, DaemonSet mode means every node runs a collector (low latency, local buffering). Deployment mode with multiple replicas works as a gateway (centralized processing, better sampling). Most production setups use both—DaemonSet for receiving, Deployment for processing and export.

## Connecting the Stack: Grafana as the Pane of Glass

With traces in Tempo, metrics in Mimir/Prometheus, and logs in Loki, Grafana ties everything together. The magic happens with trace-to-logs and trace-to-metrics links. In Grafana, configure your Tempo datasource with:

- **Trace to logs**: Point to your Loki datasource, filter by `{service_name="${__span.tags.service.name}"}`
- **Trace to metrics**: Link to your Prometheus datasource with queries based on `service`, `operation`, and `status_code` labels

Now clicking a span in a trace view jumps directly to correlated logs and the relevant metric dashboards. This three-way correlation is what turns "checkout is slow" from a two-hour investigation into a two-minute one.

## Your Next Step

Deploy the collector config above to a staging environment, instrument one service with the SDK setup, and send a few requests. Run `otel-collector --config otel-collector-config.yaml` locally if you want to validate configs before Kubernetes deployment. Once you see your first trace appear in Tempo (or Jaeger), you've crossed the threshold—everything after is iteration. Start with traces, add metrics when you need SLOs, add logs when traces don't give enough context. That ordering reflects where value accrues fastest.