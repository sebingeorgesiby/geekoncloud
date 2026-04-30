---
title: Distributed Tracing with Grafana Tempo: Production Setup Guide
date: 2026-04-30
excerpt: Deploy Grafana Tempo for distributed tracing. Complete setup with OpenTelemetry, trace correlation, and real query examples for debugging microservices.
tags: ["observability","grafana-tempo","distributed-tracing","opentelemetry","kubernetes"]
author: GeekOnCloud
draft: false
---

Your microservices architecture is humming along until a request takes 47 seconds instead of 200 milliseconds. The user complaints roll in, and you're staring at dozens of service logs trying to piece together what happened. This is where distributed tracing stops being a "nice to have" and becomes the difference between a 10-minute fix and a 4-hour war room.

Grafana Tempo is an open-source, high-scale distributed tracing backend that stores traces cheaply in object storage. Unlike Jaeger or Zipkin, Tempo doesn't require Elasticsearch or Cassandra — it writes directly to S3, GCS, or Azure Blob Storage. When paired with Grafana, you get a complete observability stack that actually scales without bankrupting your infrastructure budget.

## Why Tempo Over Jaeger or Zipkin

Tempo's architecture is fundamentally different. Traditional tracing backends index every trace attribute, which gets expensive fast. Tempo takes a different approach: it stores traces in object storage and relies on trace IDs for lookup. No indexing, no expensive queries across all traces.

The trade-off is clear. You can't search by arbitrary attributes like "show me all traces where `user_id=12345`" directly in Tempo. Instead, you use Loki logs or Prometheus metrics to find the trace ID, then jump directly to that trace. This "traces as needles, logs as the haystack" model actually works better in practice because you're usually starting from an error log or a spike in your metrics anyway.

Storage costs tell the real story. A mid-size deployment generating 50GB of traces per day costs roughly $45/month on S3 versus $500+ for an Elasticsearch cluster sized for the same workload. At scale, this difference becomes orders of magnitude.

## Deploying Tempo with Docker Compose

Let's get a working Tempo instance running. This configuration handles a few thousand spans per second, which covers most staging environments and smaller production workloads:

```yaml
version: "3.8"

services:
  tempo:
    image: grafana/tempo:2.3.1
    command: ["-config.file=/etc/tempo.yaml"]
    volumes:
      - ./tempo.yaml:/etc/tempo.yaml
      - tempo-data:/var/tempo
    ports:
      - "3200:3200"   # tempo API
      - "4317:4317"   # OTLP gRPC
      - "4318:4318"   # OTLP HTTP
      - "9411:9411"   # Zipkin

  grafana:
    image: grafana/grafana:10.2.2
    environment:
      - GF_AUTH_ANONYMOUS_ENABLED=true
      - GF_AUTH_ANONYMOUS_ORG_ROLE=Admin
    ports:
      - "3000:3000"
    volumes:
      - ./grafana-datasources.yaml:/etc/grafana/provisioning/datasources/datasources.yaml

volumes:
  tempo-data:
```

Now the Tempo configuration file. This uses local filesystem storage — swap to S3 for production:

```yaml
# tempo.yaml
server:
  http_listen_port: 3200

distributor:
  receivers:
    otlp:
      protocols:
        grpc:
          endpoint: "0.0.0.0:4317"
        http:
          endpoint: "0.0.0.0:4318"
    zipkin:
      endpoint: "0.0.0.0:9411"

ingester:
  max_block_duration: 5m

compactor:
  compaction:
    block_retention: 48h

storage:
  trace:
    backend: local
    local:
      path: /var/tempo/traces
    wal:
      path: /var/tempo/wal

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

The `metrics_generator` section is crucial — it automatically generates RED metrics (Rate, Errors, Duration) from your traces and ships them to Prometheus. This means you get service graphs and span metrics without instrumenting twice.

## Instrumenting Your Application

Tempo accepts traces via OTLP (OpenTelemetry), Jaeger, or Zipkin protocols. OpenTelemetry is the right choice for new instrumentation. Here's a Python FastAPI example:

```python
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.sdk.resources import Resource

resource = Resource.create({"service.name": "order-service"})
provider = TracerProvider(resource=resource)

# Point to your Tempo instance
otlp_exporter = OTLPSpanExporter(
    endpoint="tempo:4317",
    insecure=True
)

provider.add_span_processor(BatchSpanProcessor(otlp_exporter))
trace.set_tracer_provider(provider)

# Auto-instrument FastAPI
from fastapi import FastAPI
app = FastAPI()
FastAPIInstrumentor.instrument_app(app)
```

For Go services, the setup is similar but uses the Go OTEL SDK. The key configuration that people miss: set `OTEL_PROPAGATORS=tracecontext,baggage` in your environment so trace context propagates correctly across HTTP calls.

## Connecting the Dots in Grafana

Tempo alone shows you individual traces. The real power comes from linking logs, metrics, and traces together. Configure Grafana with derived fields in Loki that extract trace IDs and link directly to Tempo:

```yaml
# grafana-datasources.yaml
apiVersion: 1

datasources:
  - name: Tempo
    type: tempo
    access: proxy
    url: http://tempo:3200
    jsonData:
      tracesToLogsV2:
        datasourceUid: loki
        spanStartTimeShift: "-1h"
        spanEndTimeShift: "1h"
        filterByTraceID: true
        filterBySpanID: false
      serviceMap:
        datasourceUid: prometheus
      nodeGraph:
        enabled: true

  - name: Loki
    type: loki
    access: proxy
    url: http://loki:3100
    jsonData:
      derivedFields:
        - name: TraceID
          matcherRegex: "trace_id=([a-f0-9]+)"
          url: "$${__value.raw}"
          datasourceUid: tempo
```

With this configuration, clicking a trace ID in any Loki log jumps directly to the full trace in Tempo. The `tracesToLogsV2` config does the reverse — from any span in Tempo, you can jump to the correlated logs in Loki.

## Production Considerations

Running Tempo at scale requires a few adjustments. First, switch to S3 storage:

```yaml
storage:
  trace:
    backend: s3
    s3:
      bucket: your-tempo-bucket
      endpoint: s3.us-east-1.amazonaws.com
      region: us-east-1
```

Second, deploy Tempo in microservices mode for horizontal scaling. The monolithic mode works up to roughly 100GB of traces per day. Beyond that, you'll want separate distributor, ingester, and compactor components behind a load balancer.

Third, implement sampling. Sending 100% of traces to storage is expensive and usually unnecessary. Use tail-based sampling with the OpenTelemetry Collector to capture all error traces and a percentage of successful ones:

```yaml
processors:
  tail_sampling:
    decision_wait: 10s
    policies:
      - name: errors
        type: status_code
        status_code:
          status_codes: [ERROR]
      - name: slow-traces
        type: latency
        latency:
          threshold_ms: 1000
      - name: probabilistic
        type: probabilistic
        probabilistic:
          sampling_percentage: 10
```

This configuration keeps all error traces, all traces over 1 second, and 10% of everything else. Adjust the percentage based on your volume and budget.

## What to Build Next

You've got Tempo running, but tracing infrastructure without trace-aware alerting is half the value. Set up alerts on the RED metrics Tempo generates: alert when p99 latency exceeds your SLO, when error rates spike, or when a service's span count drops (indicating potential failures).

The next step is adding trace exemplars to your Prometheus metrics. When your latency alert fires, you'll have direct links to example traces that show exactly which requests were slow. Configure this with the `exemplars` feature in your metrics scrape config and the matching Tempo data source setup in Grafana. That's when distributed tracing stops being a debugging tool and becomes your first line of defense.