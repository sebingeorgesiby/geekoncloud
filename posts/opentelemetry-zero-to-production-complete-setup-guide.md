---
title: "OpenTelemetry Setup Guide: Zero to Production in 2024"
date: 2026-07-05
excerpt: "Deploy OpenTelemetry end-to-end: auto-instrumentation, collector pipelines, Jaeger/Prometheus backends. Real configs, actual latency numbers included."
tags: ["opentelemetry","observability","distributed-tracing","kubernetes","monitoring"]
author: GeekOnCloud
draft: false
---

You've probably heard "just add OpenTelemetry" thrown around like it's a five-minute task. It's not. But it's also not the multi-month odyssey some vendors want you to believe. I've rolled out OTel across three production environments in the past year, and I'm going to walk you through exactly what worked—complete configs, actual gotchas, and the shortcuts that saved me weeks of debugging.

## Understanding the OpenTelemetry Architecture

Before touching any config files, you need to understand what you're actually deploying. OpenTelemetry has three core signal types: traces, metrics, and logs. Each flows through a pipeline: instrumentation → SDK → exporter → collector → backend.

The Collector is where most people get confused. It's a standalone binary that receives, processes, and exports telemetry data. You can run it as an agent (sidecar/daemonset) or as a gateway (centralized service). For most production setups, you want both: agents on each node for low-latency collection, gateway for aggregation and export.

Here's the mental model that clicks for most engineers: think of the Collector like nginx for observability data. It receives traffic (telemetry), can transform it (processors), and forwards it to backends (exporters). Once that clicked for me, the config files made a lot more sense.

## Installing the OpenTelemetry Collector

Skip the contrib distribution unless you need specific receivers. The core distribution handles 90% of use cases and has a smaller attack surface. For Kubernetes, use the official Helm chart—it's maintained and actually works.

```bash
helm repo add open-telemetry https://open-telemetry.github.io/opentelemetry-helm-charts
helm repo update

# Deploy as DaemonSet (agent mode) - one collector per node
helm install otel-agent open-telemetry/opentelemetry-collector \
  --set mode=daemonset \
  --set presets.kubernetesAttributes.enabled=true \
  --set presets.kubeletMetrics.enabled=true \
  --namespace observability \
  --create-namespace

# Deploy as Deployment (gateway mode) - centralized processing
helm install otel-gateway open-telemetry/opentelemetry-collector \
  --set mode=deployment \
  --set replicaCount=3 \
  --namespace observability
```

The `kubernetesAttributes` preset automatically enriches telemetry with pod names, namespace, node info—stuff you'll desperately want when debugging at 2 AM. The `kubeletMetrics` preset scrapes node-level metrics without needing to configure Prometheus scraping separately.

For non-Kubernetes environments, grab the binary directly:

```bash
# Linux amd64
curl -LO https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v0.96.0/otelcol_0.96.0_linux_amd64.tar.gz
tar -xzf otelcol_0.96.0_linux_amd64.tar.gz
sudo mv otelcol /usr/local/bin/

# Create systemd service
sudo tee /etc/systemd/system/otelcol.service << 'EOF'
[Unit]
Description=OpenTelemetry Collector
After=network.target

[Service]
ExecStart=/usr/local/bin/otelcol --config=/etc/otelcol/config.yaml
Restart=always
User=otel
Group=otel
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF
```

That `LimitNOFILE` matters—the collector opens a lot of connections, and you'll hit file descriptor limits fast in high-throughput environments.

## Configuring the Collector Pipeline

This is where most tutorials fail you. They show a basic config and leave you wondering why nothing shows up in your backend. Here's a production-ready config that actually works:

```yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
        max_recv_msg_size_mib: 16
      http:
        endpoint: 0.0.0.0:4318
  
  # Scrape Prometheus metrics from your apps
  prometheus:
    config:
      scrape_configs:
        - job_name: 'app-metrics'
          scrape_interval: 15s
          kubernetes_sd_configs:
            - role: pod
          relabel_configs:
            - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_scrape]
              action: keep
              regex: true

processors:
  # Batch is critical - without it you'll DDos your backend
  batch:
    send_batch_size: 1024
    send_batch_max_size: 2048
    timeout: 5s
  
  # Memory limiter prevents OOM kills
  memory_limiter:
    check_interval: 1s
    limit_mib: 1024
    spike_limit_mib: 256
  
  # Add resource attributes for all telemetry
  resource:
    attributes:
      - key: deployment.environment
        value: production
        action: upsert
      - key: service.namespace
        value: my-company
        action: upsert
  
  # Filter out noisy health checks from traces
  filter:
    traces:
      span:
        - 'attributes["http.target"] == "/healthz"'
        - 'attributes["http.target"] == "/readyz"'

exporters:
  # Send to Grafana Cloud (or any OTLP-compatible backend)
  otlphttp:
    endpoint: https://otlp-gateway-prod-us-central-0.grafana.net/otlp
    headers:
      Authorization: Basic ${env:GRAFANA_CLOUD_TOKEN}
  
  # Debug exporter - remove in prod, invaluable during setup
  debug:
    verbosity: detailed
    sampling_initial: 5
    sampling_thereafter: 100

extensions:
  health_check:
    endpoint: 0.0.0.0:13133
  zpages:
    endpoint: 0.0.0.0:55679

service:
  extensions: [health_check, zpages]
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, filter, batch, resource]
      exporters: [otlphttp]
    metrics:
      receivers: [otlp, prometheus]
      processors: [memory_limiter, batch, resource]
      exporters: [otlphttp]
    logs:
      receivers: [otlp]
      processors: [memory_limiter, batch, resource]
      exporters: [otlphttp]
```

Key details that will save you hours: processor order matters—`memory_limiter` must come first. The `batch` processor isn't optional; without it, you're sending individual spans/metrics and will crush your backend with requests. The `filter` processor dropping health check spans will reduce your trace volume by 30-60% in typical Kubernetes environments.

## Instrumenting Your Applications

The collector is ready. Now your apps need to send data to it. For auto-instrumentation (the fast path), most languages have zero-code options.

For Python applications, this just works:

```bash
pip install opentelemetry-distro opentelemetry-exporter-otlp
opentelemetry-bootstrap -a install

# Run your app with auto-instrumentation
OTEL_SERVICE_NAME=my-api \
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-agent:4317 \
OTEL_EXPORTER_OTLP_PROTOCOL=grpc \
opentelemetry-instrument python app.py
```

For Go, you need explicit instrumentation, but the net/http wrapper is straightforward:

```go
import (
    "go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
    "go.opentelemetry.io/otel"
)

// Wrap your handlers
handler := otelhttp.NewHandler(http.HandlerFunc(myHandler), "my-endpoint")
```

For Java, attach the agent at runtime:

```bash
java -javaagent:opentelemetry-javaagent.jar \
     -Dotel.service.name=my-java-service \
     -Dotel.exporter.otlp.endpoint=http://otel-agent:4317 \
     -jar myapp.jar
```

The Java agent auto-instruments most frameworks: Spring Boot, JDBC, Hibernate, gRPC, Kafka—it just picks them up. I've seen it add 2-5% latency overhead in benchmarks, which is acceptable for the observability you get.

## Production Hardening

Three things will bite you in production that never show up in tutorials:

**Resource limits**: The collector will consume memory proportional to your throughput. Start with 512Mi memory limit, watch `otelcol_process_memory_rss` metric, and adjust. I've seen collectors need 2Gi+ for high-throughput services (>10k spans/second).

**High availability**: Run at least 3 gateway replicas behind a load balancer. The collector is stateless—horizontal scaling just works. Use pod anti-affinity to spread across nodes.

**Backpressure handling**: When your backend is slow or down, the collector will buffer in memory until `memory_limiter` kicks in and starts dropping data. Add the `sending_queue` to your exporter for persistence:

```yaml
exporters:
  otlphttp:
    endpoint: https://your-backend/otlp
    sending_queue:
      enabled: true
      num_consumers: 10
      queue_size: 5000
    retry_on_failure:
      enabled: true
      initial_interval: 5s
      max_interval: 30s
```

This buffers up to 5000 batches in memory and retries failed exports with exponential backoff.

## Your Next Step

You have a working collector config. Before deploying to production, run it locally with the `debug` exporter enabled and send test traces using `telemetrygen`:

```bash
go install github.com/open-telemetry/opentelemetry-collector-contrib/cmd/telemetrygen@latest
telemetrygen traces --otlp-endpoint localhost:4317 --otlp-insecure --traces 100
```

Watch the debug output—you should see your traces flowing through with all the resource attributes you configured. Once that works, swap the debug exporter for your real backend, remove `debug` from the pipeline, and ship it.