---
title: "Prometheus Alerting Rules That Actually Matter in Production"
date: 2026-05-09
excerpt: "Cut through alert noise with battle-tested Prometheus rules. Real thresholds, actual configs, and the alerts that wake you up for good reason."
tags: ["prometheus","monitoring","alerting","sre","observability"]
author: GeekOnCloud
draft: false
---

Most Prometheus alerting setups I've inherited look the same: 200+ rules, 90% of which are either permanently firing, permanently silenced, or so vague that on-call engineers ignore them. The problem isn't Prometheus—it's that teams copy-paste community rules without understanding what actually matters for their systems.

After years of managing alerting for production systems handling millions of requests, I've converged on a specific set of rules that consistently catch real problems while keeping noise under control. Here's what actually works.

## The SLO-First Approach: Stop Alerting on Symptoms

Before writing a single alert, answer this question: "What promises have we made to users?" If you can't answer that, you're not ready to alert on anything.

The fundamental shift is moving from symptom-based alerting (CPU is high!) to SLO-based alerting (we're burning through our error budget too fast). Here's a practical error budget burn rate alert:

```yaml
groups:
  - name: slo-alerts
    rules:
      # Fast burn - 2% of monthly budget in 1 hour
      - alert: HighErrorBudgetBurn
        expr: |
          (
            sum(rate(http_requests_total{status=~"5.."}[1h]))
            /
            sum(rate(http_requests_total[1h]))
          ) > (14.4 * 0.001)
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Burning error budget 14.4x faster than sustainable"
          description: "Current error rate: {{ $value | humanizePercentage }}"
          runbook_url: "https://runbooks.internal/slo-breach"

      # Slow burn - 5% of monthly budget in 6 hours  
      - alert: ErrorBudgetBurnSlow
        expr: |
          (
            sum(rate(http_requests_total{status=~"5.."}[6h]))
            /
            sum(rate(http_requests_total[6h]))
          ) > (6 * 0.001)
        for: 15m
        labels:
          severity: warning
        annotations:
          summary: "Sustained error budget burn at 6x rate"
```

The magic number 14.4 comes from: if your monthly error budget is 0.1% (99.9% SLO), burning at 14.4x that rate means you'll exhaust 2% of your monthly budget in just 1 hour. That's a page-worthy event. The slow burn at 6x catches sustained degradation that might fly under the radar.

## Saturation Alerts That Predict Outages

The USE method (Utilization, Saturation, Errors) is well-known, but most teams get saturation wrong. They alert when something hits 80% and wonder why they still get surprised by outages.

The trick is predicting exhaustion, not reacting to thresholds:

```yaml
groups:
  - name: saturation-predictive
    rules:
      # Disk will fill in 4 hours at current rate
      - alert: DiskWillFillIn4Hours
        expr: |
          (
            node_filesystem_avail_bytes{fstype!~"tmpfs|overlay"}
            /
            (
              node_filesystem_avail_bytes{fstype!~"tmpfs|overlay"} 
              - 
              (predict_linear(node_filesystem_avail_bytes{fstype!~"tmpfs|overlay"}[1h], 4*3600))
            )
          ) < 0
          and
          node_filesystem_avail_bytes{fstype!~"tmpfs|overlay"} < 100e9
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Disk {{ $labels.mountpoint }} will fill within 4 hours"
          current_free: "{{ $value | humanize1024 }}B"

      # Memory pressure - actual swapping, not just low free memory
      - alert: MemoryPressureSwapping
        expr: rate(node_vmstat_pgmajfault[5m]) > 100
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High major page fault rate indicates memory pressure"
          description: "{{ $value }} major faults/sec on {{ $labels.instance }}"
```

The disk alert combines `predict_linear` with an absolute threshold (`< 100GB`). Without the absolute check, you'll get alerts for petabyte volumes where 0.1% change triggers the prediction math.

For memory, forget "free memory < 10%"—Linux aggressively uses memory for caching, and that's fine. Alert on `pgmajfault` (major page faults), which means the system is actually paging to disk and users are feeling it.

## Kubernetes-Specific Rules Worth Keeping

If you're running Kubernetes, you've probably encountered the kube-prometheus stack's default rules. Here's what to keep, what to tune, and what to delete:

**Keep and tune:**

```yaml
groups:
  - name: kubernetes-apps
    rules:
      # Pod stuck in non-running state
      - alert: KubePodNotReady
        expr: |
          sum by (namespace, pod) (
            max by (namespace, pod) (kube_pod_status_phase{phase=~"Pending|Unknown"}) * 
            on(namespace, pod) group_left(owner_kind) 
            topk by (namespace, pod) (1, max by (namespace, pod, owner_kind) (kube_pod_owner{owner_kind!="Job"}))
          ) > 0
        for: 15m  # Not 5m - deployments need time
        labels:
          severity: warning
        annotations:
          summary: "Pod {{ $labels.namespace }}/{{ $labels.pod }} not ready for 15m"

      # Container restarts - but not during deployments
      - alert: KubePodCrashLooping
        expr: |
          max_over_time(kube_pod_container_status_waiting_reason{reason="CrashLoopBackOff"}[5m]) >= 1
          unless on(namespace, pod)
          (time() - kube_pod_created < 300)
        for: 10m
        labels:
          severity: critical
        annotations:
          summary: "{{ $labels.namespace }}/{{ $labels.pod }} crash looping"
```

The key modifications: exclude Jobs from pod readiness checks (they're supposed to terminate), add a grace period for newly created pods, and extend the `for` duration because 5 minutes of Pending during a cluster scale-up is normal.

**Delete these default rules:**
- `KubeMemoryOvercommit` - Overcommit is a feature, not a bug
- `KubeCPUOvercommit` - Same reasoning
- `NodeClockSkew` - Unless you're running bare metal without NTP

## The Alerts You're Missing

After auditing dozens of production setups, these are consistently absent and consistently useful:

```yaml
groups:
  - name: often-missing
    rules:
      # Certificate expiry - 14 days warning, 7 days critical
      - alert: CertificateExpiringCritical
        expr: |
          (probe_ssl_earliest_cert_expiry - time()) / 86400 < 7
        labels:
          severity: critical
        annotations:
          summary: "Certificate for {{ $labels.instance }} expires in {{ $value | humanize }} days"

      # Prometheus itself falling behind
      - alert: PrometheusTargetScrapesSlow
        expr: |
          prometheus_target_interval_length_seconds{quantile="0.99"} 
          / on() group_left 
          prometheus_target_interval_length_seconds{quantile="0.5"} > 1.5
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Prometheus scrape intervals degraded - p99 is 50% higher than median"

      # Actual blackbox connectivity, not just port open
      - alert: ServiceEndpointDown
        expr: probe_success{job="blackbox-http"} == 0
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Blackbox probe failing for {{ $labels.instance }}"
```

The Prometheus self-monitoring rule catches a common failure mode: Prometheus getting overloaded and falling behind on scrapes, which means your dashboards show stale data and alerts fire late.

## Practical Implementation: The Alert Audit

Run this query to find your noisiest alerts over the past week:

```bash
# Top 10 most-firing alerts
curl -s "http://prometheus:9090/api/v1/query?query=topk(10,sum%20by(alertname)(ALERTS{alertstate=\"firing\"}))" | jq '.data.result[] | {alert: .metric.alertname, count: .value[1]}'

# Alerts that fired but never resolved (stuck)
curl -s "http://prometheus:9090/api/v1/query?query=ALERTS{alertstate=\"firing\"}" | jq '.data.result | length'
```

If any alert appears more than 10 times per week, either the threshold is wrong, the underlying issue needs fixing, or the alert should be deleted.

For every alert you have, ask: "What action does on-call take when this fires?" If the answer is "acknowledge and wait" or "check the dashboard," delete it. Alerts are for immediate human action, not monitoring.

Start by deleting 50% of your current alerts. I'm serious. Then add back only the ones where someone says "I really needed that."