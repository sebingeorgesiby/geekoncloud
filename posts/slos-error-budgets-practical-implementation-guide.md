---
title: "SLOs and Error Budgets: A Practical Implementation Guide"
date: 2026-06-03
excerpt: "Skip the SRE theory. Real configs for Prometheus alerting rules, error budget burn rate calculations, and actual SLO policies that work in production."
tags: ["SRE","observability","prometheus","reliability-engineering","monitoring"]
author: GeekOnCloud
draft: false
---

You've read the SRE book. You know the theory: define SLOs, track error budgets, slow down when you're burning too fast. Beautiful in principle. But when Monday hits and you're staring at Prometheus, the question is simple: "How do I actually set this up?"

Let's skip the philosophy and build a working SLO system. By the end, you'll have real configs, real alerts, and a dashboard that tells you whether to ship or fix.

## Pick Your SLIs First (And Pick Fewer Than You Think)

Everyone wants to measure everything. Don't. You need two, maybe three SLIs that actually matter to users. Here's the hierarchy that works for 90% of services:

**Availability** — Did the request succeed? (HTTP 5xx = bad, everything else = good)

**Latency** — Was it fast enough? (p99 under some threshold)

**Correctness** — Was the answer right? (This one's hard to measure generically, skip it initially)

Start with availability and latency. That's it. Here's the mental model: your SLI is a ratio of "good events" to "total events" over a time window.

For a typical API service:

```yaml
# Good events: requests that returned 2xx or 4xx (4xx is client's fault, not yours)
# Bad events: requests that returned 5xx
# Total events: all requests

availability_sli = (total_requests - server_errors) / total_requests

# For latency, you're measuring a different ratio:
# Good events: requests faster than threshold
# Bad events: requests slower than threshold

latency_sli = requests_under_500ms / total_requests
```

Notice I said 4xx counts as "good." This trips people up. A 404 or 400 means your service worked correctly — the client sent garbage. Only 5xx means *you* broke something.

## The Actual Prometheus Queries

Theory's over. Here's what you put in Prometheus. Assuming you're using standard `http_requests_total` and `http_request_duration_seconds_bucket` metrics:

```yaml
# recording_rules.yml
groups:
  - name: slo_recording_rules
    interval: 1m
    rules:
      # Error ratio (availability SLI)
      - record: slo:http_errors:ratio_rate5m
        expr: |
          sum(rate(http_requests_total{status=~"5.."}[5m])) by (service)
          /
          sum(rate(http_requests_total[5m])) by (service)

      # Latency SLI - percentage of requests over 500ms
      - record: slo:http_latency_above_threshold:ratio_rate5m
        expr: |
          1 - (
            sum(rate(http_request_duration_seconds_bucket{le="0.5"}[5m])) by (service)
            /
            sum(rate(http_request_duration_seconds_count[5m])) by (service)
          )

      # Combined error budget consumption (30 day window)
      # Assumes 99.9% availability target = 0.1% error budget
      - record: slo:error_budget_remaining:ratio
        expr: |
          1 - (
            slo:http_errors:ratio_rate5m / 0.001
          )
```

The key insight: `le="0.5"` in the latency query means "less than or equal to 500ms." Prometheus histograms are cumulative buckets, so this gives you count of requests faster than your threshold.

That `error_budget_remaining` metric is your north star. When it hits zero, you've burned your budget for the period.

## Set Your Target (99.9% Is Probably Wrong)

Here's the uncomfortable truth: 99.99% availability for a startup's internal tool is insane. You're not Google. Your users don't need four nines.

Do this math instead:

```
99% availability = 7.3 hours downtime/month
99.5% = 3.6 hours/month  
99.9% = 43 minutes/month
99.95% = 21 minutes/month
99.99% = 4.3 minutes/month
```

For most internal services, 99.5% is plenty. For customer-facing APIs, 99.9% is reasonable. For payment processing, maybe 99.95%.

Pick your target based on two factors:
1. What can you actually achieve with current architecture?
2. What do users actually need?

If you've never measured, start at 99.5% and tighten after you have data. Setting 99.99% when you're currently at 99.7% just means you'll always be "out of budget" and the system becomes meaningless.

## Alerting That Actually Works

Here's where most SLO implementations fail: they set alerts on the raw SLI. "Alert me when error rate exceeds 0.1%." This fires constantly and you ignore it.

Instead, alert on *burn rate* — how fast you're consuming your error budget:

```yaml
# alerting_rules.yml
groups:
  - name: slo_alerts
    rules:
      # Fast burn - 14.4x budget consumption = 2% budget in 1 hour
      # This catches major outages
      - alert: SLOHighBurnRate_Critical
        expr: |
          slo:http_errors:ratio_rate5m > (14.4 * 0.001)
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "{{ $labels.service }} burning error budget 14x faster than sustainable"
          description: "At this rate, entire monthly budget exhausted in 2 days"

      # Slow burn - 3x budget consumption 
      # Catches slow degradation over hours
      - alert: SLOHighBurnRate_Warning
        expr: |
          slo:http_errors:ratio_rate5m > (3 * 0.001)
        for: 30m
        labels:
          severity: warning
        annotations:
          summary: "{{ $labels.service }} elevated error rate affecting SLO"

      # Budget exhausted - you're now borrowing from next month
      - alert: SLOBudgetExhausted
        expr: |
          slo:error_budget_remaining:ratio < 0
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "{{ $labels.service }} has exhausted monthly error budget"
```

The magic numbers: 14.4x and 3x come from Google's multi-window, multi-burn-rate alerting. The short version: 14.4x burn rate sustained for 1 hour = 2% of monthly budget gone. That's worth waking someone up at 3am.

3x burn rate over 6 hours = 2% budget. Worth a warning, but not a page.

## The Dashboard That Drives Decisions

Your engineering lead walks in Monday morning. They should look at one dashboard and know: "Can we ship, or do we need to pay down tech debt?"

Build this in Grafana:

**Panel 1: Error Budget Remaining (gauge, 0-100%)**
```
slo:error_budget_remaining:ratio * 100
```
Green above 50%, yellow 25-50%, red below 25%.

**Panel 2: Budget Burn Over Time (time series, 30 days)**
```
1 - (sum_over_time(slo:http_errors:ratio_rate5m[30d]) / (30 * 24 * 12 * 0.001))
```
Shows the trajectory. Are you burning faster lately?

**Panel 3: Current Error Rate vs Target (stat panel)**
```
slo:http_errors:ratio_rate5m
```
With threshold markers at your SLO target.

**Panel 4: Time Until Budget Exhaustion (stat panel)**
```
slo:error_budget_remaining:ratio / slo:http_errors:ratio_rate5m / 60 / 24
```
Shows days remaining at current burn rate. Nothing focuses the mind like "3 days until budget exhausted."

## Making It Stick: The Policy Part

Tech is the easy part. The hard part is getting humans to respect the system.

Write down these rules and get engineering leadership to agree:

1. **Budget above 50%**: Ship freely. Move fast.
2. **Budget 25-50%**: Ship, but include reliability work in each sprint.
3. **Budget below 25%**: Feature freeze unless it improves reliability.
4. **Budget exhausted**: All hands on reliability until positive budget.

This isn't about punishing teams. It's about making tradeoffs explicit. When product asks "why can't we ship the new feature?" the answer is data, not opinion.

## Start Tomorrow

Stop reading and do this:

1. Add the recording rules to your Prometheus config
2. Pick one service, set a 99.5% target
3. Build the single-gauge "budget remaining" panel
4. Show it to your team lead

You can iterate on thresholds, add latency SLIs, tune alert sensitivity — but only after you have baseline data. The perfect SLO system you design in a doc is worth less than the simple one running in production.

The error budget isn't about math. It's about having a number everyone agrees on so arguments about "how much reliability is enough" turn into "what does the data say." That conversation is worth setting up the infrastructure.