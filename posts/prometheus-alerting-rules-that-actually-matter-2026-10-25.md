---
title: "Prometheus Alerting Rules That Actually Matter in Production"
date: 2026-10-25
excerpt: "Cut through alert noise with battle-tested Prometheus rules. Real thresholds, actual configs, and the alerts that page engineers at 3am for good reason."
tags: ["prometheus","monitoring","alerting","sre","observability"]
author: GeekOnCloud
draft: false
---

Most Prometheus alerting setups I've audited are disasters. Teams copy-paste example alerts from GitHub, end up with 200+ rules, and then ignore all of them because the noise is unbearable. The result? When something actually breaks at 3 AM, the alert that matters is buried under 47 notifications about disk space on a dev server nobody uses.

Here's the thing: you don't need more alerts. You need fewer alerts that actually predict or indicate customer impact. I'm going to show you the alerting rules I deploy on every production system, why they work, and the specific thresholds that have held up across dozens of environments.

## The Four Golden Signals, Actually Implemented

Google's SRE book talks about latency, traffic, errors, and saturation. Everyone nods along, then goes back to alerting on CPU percentage. Let's fix that.

Here's a starter set that covers the golden signals for a typical web service:

```yaml
groups:
  - name: golden_signals
    rules:
      # Latency: Alert when p99 latency exceeds SLO
      - alert: HighLatencyP99
        expr: |
          histogram_quantile(0.99, 
            sum(rate(http_request_duration_seconds_bucket{job="api"}[5m])) by (le)
          ) > 0.5
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "P99 latency above 500ms for 5 minutes"
          runbook: "https://wiki.internal/runbooks/high-latency"

      # Traffic: Alert on significant drop (indicates upstream issues or outage)
      - alert: TrafficDrop
        expr: |
          sum(rate(http_requests_total{job="api"}[5m])) 
          < (sum(rate(http_requests_total{job="api"}[5m] offset 1h)) * 0.5)
        for: 10m
        labels:
          severity: critical
        annotations:
          summary: "Traffic dropped by 50%+ compared to 1 hour ago"

      # Errors: Alert when error rate exceeds threshold
      - alert: HighErrorRate
        expr: |
          sum(rate(http_requests_total{job="api",status=~"5.."}[5m])) 
          / sum(rate(http_requests_total{job="api"}[5m])) > 0.01
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Error rate above 1% for 5 minutes"

      # Saturation: Alert when we're running out of headroom
      - alert: HighSaturation
        expr: |
          sum(rate(http_requests_total{job="api"}[5m])) 
          > (sum(kube_deployment_spec_replicas{deployment="api"}) * 100 * 0.8)
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Request rate at 80% of estimated capacity"
```

Notice a few things: every alert has a `for` duration. This eliminates transient spikes. The traffic drop alert compares against historical data rather than a static threshold—this handles daily traffic patterns automatically. The saturation alert assumes ~100 RPS per pod as capacity (adjust this based on your load testing).

## Stop Alerting on Symptoms, Start Alerting on Causes

CPU at 90%? Not an alert. CPU at 90% *and* request latency degraded? Now we're talking.

The problem with resource-based alerts is they don't tell you if users are impacted. I've seen systems run happily at 95% CPU for months. I've also seen systems fall over at 40% CPU because of a memory leak causing GC pauses.

Here's my approach: resource alerts should be *informational*, not paging. They go to a dashboard or a Slack channel for situational awareness. Only user-impacting conditions page someone.

```yaml
groups:
  - name: resource_info
    rules:
      # This goes to Slack, not PagerDuty
      - alert: HighCPUInfo
        expr: |
          avg(rate(container_cpu_usage_seconds_total{namespace="production"}[5m])) 
          by (pod) 
          / avg(kube_pod_container_resource_limits{resource="cpu",namespace="production"}) 
          by (pod) > 0.85
        for: 15m
        labels:
          severity: info
          channel: infrastructure
        annotations:
          summary: "Pod {{ $labels.pod }} CPU above 85% of limit"

  - name: resource_critical
    rules:
      # This pages someone - resource exhaustion + user impact
      - alert: OOMImminent
        expr: |
          (container_memory_usage_bytes{namespace="production"} 
          / container_spec_memory_limit_bytes{namespace="production"}) > 0.9
          and on(pod) 
          (rate(http_requests_total{status=~"5.."}[2m]) > 0)
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Pod {{ $labels.pod }} near OOM and serving errors"
```

The second alert only fires when memory pressure *and* errors occur together. This eliminates false positives from apps that legitimately use most of their allocated memory.

## The Alerts You're Missing: Data Plane Health

Application metrics are great, but you also need to monitor the monitoring. Nothing's worse than finding out your metrics pipeline was broken for 6 hours after an incident.

```yaml
groups:
  - name: meta_monitoring
    rules:
      - alert: PrometheusTargetDown
        expr: up{job=~"api|worker|database"} == 0
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Prometheus cannot scrape {{ $labels.instance }}"

      - alert: PrometheusTargetScrapeSlow
        expr: scrape_duration_seconds > 10
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Scrape taking >10s for {{ $labels.instance }}"

      - alert: NoDataReceived
        expr: |
          absent(rate(http_requests_total{job="api"}[5m])) 
          or rate(http_requests_total{job="api"}[5m]) == 0
        for: 10m
        labels:
          severity: critical
        annotations:
          summary: "No request metrics from API - pipeline may be broken"
```

The `absent()` function is criminally underused. It fires when a metric that should exist doesn't. This catches scenarios where your app is running but stopped emitting metrics.

## Threshold Tuning: The Numbers That Work

Static thresholds fail because systems aren't static. Here's how I handle this:

**For latency**: Use SLO-based thresholds. If your SLO is 99% of requests under 500ms, alert when you're burning through error budget:

```yaml
- alert: SLOBurnRateCritical
  expr: |
    (
      sum(rate(http_request_duration_seconds_bucket{le="0.5"}[1h])) 
      / sum(rate(http_request_duration_seconds_count[1h]))
    ) < 0.99 - (0.01 * 14.4)
  for: 5m
  labels:
    severity: critical
  annotations:
    summary: "Burning through monthly error budget in <2 hours at current rate"
```

The `14.4` multiplier means you'd exhaust your entire monthly budget in ~2 hours at this burn rate. Adjust based on your tolerance.

**For error rates**: 1% is usually the right starting point for critical alerts. 0.1% for warning. But measure your baseline first—some systems have legitimate background error rates from client bugs.

**For disk**: Alert at 80% *and* predict when you'll hit 100%:

```yaml
- alert: DiskWillFill
  expr: |
    predict_linear(node_filesystem_avail_bytes{mountpoint="/"}[6h], 24*60*60) < 0
  for: 30m
  labels:
    severity: warning
  annotations:
    summary: "Disk {{ $labels.mountpoint }} will fill within 24 hours"
```

`predict_linear` is magic. It extrapolates current trends and tells you when you'll hit zero. Way more useful than a static percentage.

## Making Alerts Actionable

Every alert annotation should include a runbook link. Period. If someone gets paged and doesn't know what to do, your alert is useless.

Use Alertmanager routing to ensure alerts go to the right place:

```yaml
route:
  receiver: slack-infrastructure
  routes:
    - match:
        severity: critical
      receiver: pagerduty-oncall
      continue: true
    - match:
        severity: critical
      receiver: slack-incidents
    - match:
        severity: warning
      receiver: slack-infrastructure
    - match:
        severity: info
      receiver: slack-info
```

The `continue: true` lets critical alerts hit both PagerDuty and Slack. Redundancy matters when things are on fire.

## Your Next Step

Audit your current alerts. Run this query to see which ones have fired in the last 30 days:

```bash
curl -s "http://prometheus:9090/api/v1/query?query=ALERTS" | jq '.data.result[] | .metric.alertname' | sort | uniq -c | sort -rn
```

Any alert that hasn't fired in 30 days either has a broken expression or a threshold that's too conservative. Any alert that fires daily is either too sensitive or you have a real problem you've been ignoring. Fix both categories, and you'll cut your alert volume by 70% while catching more real issues.