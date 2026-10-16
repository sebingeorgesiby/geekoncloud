---
title: "MTTR vs MTBF: Which Reliability Metric Actually Matters"
date: 2026-10-16
excerpt: "Stop obsessing over MTBF. Learn why MTTR drives real reliability, how to measure both metrics properly, and the formulas that actually work in production."
tags: ["sre","reliability-engineering","incident-management","observability","devops-metrics"]
author: GeekOnCloud
draft: false
---

When your production database went down last Tuesday at 2 AM, your CEO didn't ask about your four-nines SLA. They asked one question: "How long until it's fixed?" That's MTTR in action. Meanwhile, your SRE team has been patting themselves on the back about 847 hours between failures—your MTBF. Both metrics tell a story, but most teams are measuring the wrong one for their maturity level.

Let me cut through the acronym soup and show you which metric actually moves the needle for reliability, and more importantly, how to instrument both properly.

## The Metrics Defined (With Math That Matters)

**MTBF (Mean Time Between Failures)** measures the average operational time between system failures. Formula: `Total Operational Time / Number of Failures`

**MTTR (Mean Time to Recovery)** measures how quickly you restore service after a failure. Formula: `Total Downtime / Number of Incidents`

Here's where it gets nuanced. MTTR actually breaks down into four sub-metrics:

- **MTTD** (Detect): Time from failure occurrence to alert firing
- **MTTI** (Investigate): Time from alert to root cause identification  
- **MTTF** (Fix): Time to implement the actual repair
- **MTTV** (Verify): Time to confirm service restoration

Most teams conflate these. Don't. A 45-minute MTTR with 30 minutes spent detecting is a very different problem than 45 minutes spent fixing.

Let's instrument this properly with Prometheus:

```yaml
# prometheus/recording_rules.yml
groups:
  - name: reliability_metrics
    interval: 1m
    rules:
      # Track incident duration
      - record: incident:duration_seconds:sum
        expr: |
          sum(
            (timestamp(alertmanager_alerts{state="resolved"}) - 
             timestamp(alertmanager_alerts{state="firing"}))
          ) by (alertname, severity)
      
      # MTTR calculation (rolling 30-day window)
      - record: reliability:mttr_seconds:avg30d
        expr: |
          avg_over_time(incident:duration_seconds:sum[30d]) 
          / count_over_time(incident:duration_seconds:sum[30d])
      
      # MTBF calculation  
      - record: reliability:mtbf_seconds:avg30d
        expr: |
          (30 * 24 * 3600) / count_over_time(
            ALERTS{alertstate="firing", severity="critical"}[30d]
          )
```

## Why Most Teams Optimize the Wrong Metric

Here's my hot take: **optimizing for MTBF is a loser's game for 90% of organizations**.

MTBF optimization assumes you can prevent failures. In distributed systems, you can't. You're fighting entropy, third-party dependencies, and the fundamental unreliability of networks. Netflix figured this out a decade ago with Chaos Monkey—they stopped trying to prevent failures and started practicing recovery.

The math backs this up. Let's say you have:
- Current MTBF: 720 hours (30 days)
- Current MTTR: 2 hours
- Monthly downtime: ~2.7 hours

To achieve the same availability improvement:
- **Option A**: Double MTBF to 1440 hours → 1.35 hours monthly downtime
- **Option B**: Halve MTTR to 1 hour → 1.35 hours monthly downtime

Option B is almost always cheaper. Doubling MTBF requires architectural changes, redundancy investments, and extensive testing. Halving MTTR requires better runbooks, improved observability, and practice.

The one exception: safety-critical systems. If you're running medical devices, aviation systems, or nuclear plant controls, MTBF is your primary metric because MTTR has a floor—humans can only respond so fast, and some failures have irreversible consequences.

## Instrumenting Detection Time (The Hidden MTTR Killer)

Most MTTR problems are actually MTTD problems. I've done incident retrospectives where the service was down for 47 minutes but the pager fired at minute 38. That's a detection problem, not a recovery problem.

Here's how to instrument detection latency with a synthetic monitoring approach:

```bash
#!/bin/bash
# synthetic_health_check.sh - Run via cron every 30 seconds

ENDPOINT="https://api.yourservice.com/health"
PROMETHEUS_PUSHGATEWAY="http://pushgateway:9091"
TIMESTAMP=$(date +%s)

# Measure actual response time
START=$(date +%s.%N)
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$ENDPOINT")
END=$(date +%s.%N)
LATENCY=$(echo "$END - $START" | bc)

# Push to Prometheus
cat <<EOF | curl --data-binary @- "$PROMETHEUS_PUSHGATEWAY/metrics/job/synthetic_monitor/instance/api"
# HELP synthetic_check_latency_seconds Response time of health endpoint
# TYPE synthetic_check_latency_seconds gauge
synthetic_check_latency_seconds $LATENCY
# HELP synthetic_check_up Health check success (1) or failure (0)  
# TYPE synthetic_check_up gauge
synthetic_check_up $([ "$HTTP_CODE" = "200" ] && echo 1 || echo 0)
# HELP synthetic_check_timestamp_seconds Unix timestamp of check
# TYPE synthetic_check_timestamp_seconds gauge
synthetic_check_timestamp_seconds $TIMESTAMP
EOF

# Now the critical part: measure detection delta
# Compare synthetic failure time vs alertmanager firing time
if [ "$HTTP_CODE" != "200" ]; then
    echo "$TIMESTAMP service_down" >> /var/log/synthetic_failures.log
fi
```

Then in your incident retrospective, compare `/var/log/synthetic_failures.log` timestamps against AlertManager's firing times. The delta is your true MTTD.

## Building MTTR Into Your Incident Workflow

Abstract metrics don't improve. Processes do. Here's the incident workflow that consistently achieves sub-15-minute MTTR at organizations I've worked with:

**Phase 1: Detection (Target: <2 minutes)**
- Synthetic checks every 30 seconds
- Real-user monitoring with 99th percentile alerting
- Error budget burn-rate alerts (not just threshold alerts)

**Phase 2: Triage (Target: <3 minutes)**
- Automated incident channel creation in Slack/Teams
- Pre-populated with recent deployments, change events
- On-call auto-paged with escalation after 5 minutes

**Phase 3: Diagnosis (Target: <5 minutes)**
- Runbooks linked directly in alert annotations
- Dashboards that answer "what changed?" automatically
- Correlation of metrics, logs, and traces in single view

**Phase 4: Recovery (Target: <5 minutes)**
- One-click rollback capability for all deployments
- Feature flags to disable problematic code paths
- Database restore procedures tested monthly

The controversial part: **I recommend measuring individual engineer MTTR, anonymized and aggregated**. Not for performance reviews—for training investment. If your newest hire takes 3x longer to resolve incidents, they need more runbook time, not criticism.

## The Dashboard That Actually Gets Used

Executives want one number. Engineers want drill-down capability. Here's the Grafana dashboard structure that serves both:

Top row: Single stat panels showing:
- MTTR (30-day rolling average)
- MTBF (30-day rolling average)  
- Availability percentage
- Incident count

Second row: Time-series showing MTTR broken down by:
- Detection time
- Investigation time
- Fix time
- Verification time

Third row: MTTR by service, sorted worst-first. This is where engineering investment decisions come from.

Bottom row: Incident timeline showing individual incidents with duration, root cause category, and whether runbook existed.

## Your Next Step

Stop reading and do this: pull your last 10 incidents and manually calculate MTTD, MTTI, MTTF, and MTTV for each. You'll likely find that 60%+ of your MTTR is detection and investigation—not actual fixing. That's where your observability investment should go.

Then instrument it properly. The recording rules above will start collecting data immediately. In 30 days, you'll have the baseline. In 90 days, you'll have the trend. That trend—MTTR going down month over month—is the only reliability metric that matters for shipping faster without burning out your team.