---
title: "Log Aggregation with Loki: Prometheus-Native Logging Setup"
date: 2026-10-24
excerpt: "Deploy Grafana Loki for cost-effective log aggregation. Learn LogQL queries, Promtail config, and why Loki beats Elasticsearch for Kubernetes logging."
tags: ["loki","grafana","logging","prometheus","kubernetes"]
author: GeekOnCloud
draft: false
---

Every time I set up a new Kubernetes cluster, someone inevitably asks: "Should we use the ELK stack for logs?" My answer is increasingly: no. Not because Elasticsearch is bad—it's excellent at what it does—but because for most cloud-native workloads, you're paying for capabilities you don't need while missing the one thing that matters most: seamless correlation with your metrics.

Loki flips the logging model on its head. Instead of indexing log content, it indexes only metadata (labels) and stores compressed log chunks. This architectural choice makes it 10-100x cheaper to operate than Elasticsearch for equivalent workloads, while natively sharing the same label taxonomy as your Prometheus metrics.

## The Label-Based Architecture

Loki's core insight is that most log queries are scoped—you're almost never searching all logs for a substring. You're searching logs from a specific service, namespace, or pod. So why index everything?

Loki stores logs in streams, each identified by a unique label set. A stream might be `{namespace="production", app="payment-service", pod="payment-7d8f9-xk2j"}`. The actual log content is compressed and stored in chunks, never indexed.

When you query `{app="payment-service"} |= "timeout"`, Loki:
1. Finds all streams matching the label selector (fast—just a label lookup)
2. Decompresses only those chunks (parallelized)
3. Greps through the raw content for "timeout"

This sounds slow, but it isn't. A properly-tuned Loki cluster greps through 50TB of logs in seconds because it's only reading the streams you care about. I've seen queries return in under 200ms on clusters with 6 months of retained logs.

## Setting Up the Stack

The canonical deployment is Loki + Promtail + Grafana. Promtail is Loki's log shipper—think Filebeat, but built specifically for Loki with automatic Kubernetes label discovery.

Here's a production-ready Helm deployment:

```bash
# Add the Grafana helm repo
helm repo add grafana https://grafana.github.io/helm-charts
helm repo update

# Deploy Loki with a scalable configuration
helm install loki grafana/loki-stack \
  --namespace monitoring \
  --create-namespace \
  --set loki.persistence.enabled=true \
  --set loki.persistence.size=50Gi \
  --set loki.config.chunk_store_config.max_look_back_period=720h \
  --set promtail.enabled=true \
  --set grafana.enabled=true \
  --set grafana.persistence.enabled=true
```

For anything beyond a dev cluster, you'll want object storage. Loki performs dramatically better with S3/GCS/Azure Blob because it can parallelize chunk fetches:

```yaml
# loki-config.yaml - production configuration
auth_enabled: false

server:
  http_listen_port: 3100
  grpc_listen_port: 9096

common:
  path_prefix: /loki
  storage:
    s3:
      endpoint: s3.us-east-1.amazonaws.com
      bucketnames: my-loki-chunks
      region: us-east-1
      access_key_id: ${AWS_ACCESS_KEY_ID}
      secret_access_key: ${AWS_SECRET_ACCESS_KEY}
  replication_factor: 3
  ring:
    kvstore:
      store: memberlist

schema_config:
  configs:
    - from: 2024-01-01
      store: tsdb
      object_store: s3
      schema: v13
      index:
        prefix: loki_index_
        period: 24h

storage_config:
  tsdb_shipper:
    active_index_directory: /loki/index
    cache_location: /loki/cache
    cache_ttl: 24h

limits_config:
  retention_period: 744h  # 31 days
  max_query_length: 721h
  max_query_parallelism: 32
  ingestion_rate_mb: 10
  ingestion_burst_size_mb: 20
  per_stream_rate_limit: 5MB
  per_stream_rate_limit_burst: 15MB

compactor:
  working_directory: /loki/compactor
  compaction_interval: 10m
  retention_enabled: true
  retention_delete_delay: 2h
  delete_request_store: s3
```

The `schema: v13` and `store: tsdb` settings are critical—this is the new TSDB-based index format that replaced BoltDB. It's significantly faster for high-cardinality label queries.

## LogQL: Not Just Grep

LogQL looks like PromQL's cousin because it is. This shared syntax is one of Loki's killer features—your team already knows half of it.

Basic filtering:
```
{namespace="production"} |= "error"
```

Regex matching:
```
{app="api-gateway"} |~ "status=(4|5)[0-9]{2}"
```

Here's where it gets powerful—structured metadata extraction:

```
{app="nginx"} 
  | pattern `<ip> - - [<_>] "<method> <path> <_>" <status> <bytes>` 
  | status >= 400 
  | line_format "{{.ip}} hit {{.status}} on {{.path}}"
```

And metric extraction (this is the bridge to Prometheus-style alerting):

```
sum by (status) (
  rate({app="api-gateway"} 
    | json 
    | unwrap response_time_ms [5m])
)
```

That query calculates the rate of requests grouped by HTTP status, extracting `response_time_ms` from JSON-structured logs. You can alert on this in Grafana the same way you'd alert on a Prometheus metric.

## Promtail Configuration for Kubernetes

Promtail's Kubernetes integration automatically discovers pods and attaches useful labels. But the defaults need tuning:

```yaml
# promtail-config.yaml
server:
  http_listen_port: 9080
  grpc_listen_port: 0

positions:
  filename: /tmp/positions.yaml

clients:
  - url: http://loki:3100/loki/api/v1/push
    batchwait: 1s
    batchsize: 1048576  # 1MB
    timeout: 10s

scrape_configs:
  - job_name: kubernetes-pods
    kubernetes_sd_configs:
      - role: pod
    relabel_configs:
      # Only scrape pods with annotation
      - source_labels: [__meta_kubernetes_pod_annotation_promtail_io_scrape]
        action: keep
        regex: true
      
      # Use pod name as primary label
      - source_labels: [__meta_kubernetes_pod_name]
        target_label: pod
      
      # Capture namespace
      - source_labels: [__meta_kubernetes_namespace]
        target_label: namespace
      
      # Capture app label from pod
      - source_labels: [__meta_kubernetes_pod_label_app]
        target_label: app
      
      # Drop high-cardinality default labels
      - action: labeldrop
        regex: __meta_kubernetes_pod_label_pod_template_hash
    
    pipeline_stages:
      # Detect and parse JSON logs
      - match:
          selector: '{app=~".+"}'
          stages:
            - json:
                expressions:
                  level: level
                  msg: message
            - labels:
                level:
      
      # Drop debug logs in production
      - match:
          selector: '{namespace="production", level="debug"}'
          action: drop
          drop_counter_reason: debug_logs_filtered
```

The opt-in annotation (`promtail.io/scrape: "true"`) prevents log collection from every pod—a common mistake that leads to ballooning storage costs. You want to explicitly enable logging for services that matter.

## Cardinality: The One Thing That'll Kill You

Loki has one sharp edge: label cardinality. Every unique label combination creates a new stream. If you label logs with `user_id`, you'll create millions of streams and Loki will fall over.

Keep labels low-cardinality:
- ✅ `namespace`, `app`, `environment`, `log_level`
- ❌ `user_id`, `request_id`, `trace_id`

High-cardinality values belong in the log content, not in labels. You can still search for them—that's what `|=` and `|~` are for.

Monitor your stream count:
```
sum(loki_ingester_memory_streams)
```

Anything over 100k active streams per ingester and you need to revisit your labeling strategy.

## The Grafana Integration

The final piece is unified dashboards. In Grafana, add Loki as a data source, then build panels that show metrics and logs side-by-side:

```
# Prometheus query for error rate
sum(rate(http_requests_total{status=~"5.."}[5m])) by (service)

# Loki query for corresponding error logs (same dashboard, split view)
{app="$service"} |= "error" | json | line_format "{{.timestamp}} {{.message}}"
```

When you click on a spike in the error rate graph, Grafana can automatically adjust the Loki query's time range. This correlation is immediate—no context switching, no copying timestamps between tools.

Your next step: deploy this stack to a test cluster and ship logs from one service for a week. Watch the storage usage—you'll likely find it's 5-10% of what you'd pay for Elasticsearch. Then expand to your full workload and set up recording rules to extract metrics from logs for your SLO dashboards.