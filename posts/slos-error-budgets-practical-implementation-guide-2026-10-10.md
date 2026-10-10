---
title: "SLOs and Error Budgets: A Practical Implementation Guide"
date: 2026-10-10
excerpt: "Skip the SRE theory. Learn to implement SLOs and error budgets with real Prometheus queries, alerting rules, and burn rate calculations that actually work."
tags: ["SRE","observability","prometheus","reliability","monitoring"]
author: GeekOnCloud
draft: false
---

You've read the SRE book. You understand that SLOs are "a target level of reliability for your service." Cool. But when Monday morning comes and someone asks you to "implement SLOs for our payment service," what do you actually do?

Let me show you exactly how to go from zero to functioning SLOs with error budgets, using tools you probably already have.

## Start With What Users Actually Experience

Forget the theory about "nines." Start by asking: what makes a user think our service is broken?

For most services, it's one of three things:
- The request failed (5xx, timeout, connection refused)
- The request was too slow (> X seconds)
- The request returned wrong data (harder to measure, skip for now)

Pick your SLI (Service Level Indicator) based on this. Here's a concrete example for an API:

**Availability SLI:** `successful_requests / total_requests`
**Latency SLI:** `requests_under_300ms / total_requests`

That's it. Don't overcomplicate it. You can add more sophisticated SLIs later.

Now set your SLO. Most teams default to 99.9% because it sounds good. Don't. Look at your actual data:

```bash
# Check your current reliability over last 30 days
# Using Prometheus with histogram metrics

# Availability (non-5xx responses)
curl -s "http://prometheus:9090/api/v1/query" \
  --data-urlencode 'query=
    sum(rate(http_requests_total{status!~"5.."}[30d]))
    /
    sum(rate(http_requests_total[30d]))
  ' | jq '.data.result[0].value[1]'

# Latency (p99 under 300ms)
curl -s "http://prometheus:9090/api/v1/query" \
  --data-urlencode 'query=
    sum(rate(http_request_duration_seconds_bucket{le="0.3"}[30d]))
    /
    sum(rate(http_request_duration_seconds_count[30d]))
  ' | jq '.data.result[0].value[1]'
```

If you're currently at 99.7%, don't set an SLO of 99.99%. Set it at 99.5% — give yourself headroom to improve. You can tighten it later.

## Calculate Error Budget in Real Numbers

Here's where most explanations get hand-wavy. Let's be concrete.

Your error budget is the inverse of your SLO. If your SLO is 99.5%, your error budget is 0.5%.

But 0.5% of what? Translate this to real numbers your team can use:

```bash
#!/bin/bash
# error_budget_calculator.sh

SLO=99.5
WINDOW_DAYS=30

# Get total requests in window
TOTAL_REQUESTS=$(curl -s "http://prometheus:9090/api/v1/query" \
  --data-urlencode "query=sum(increase(http_requests_total[${WINDOW_DAYS}d]))" \
  | jq -r '.data.result[0].value[1]' | cut -d. -f1)

# Calculate budget
ERROR_BUDGET_PERCENT=$(echo "100 - $SLO" | bc)
ERROR_BUDGET_REQUESTS=$(echo "$TOTAL_REQUESTS * $ERROR_BUDGET_PERCENT / 100" | bc)

# Get current errors
CURRENT_ERRORS=$(curl -s "http://prometheus:9090/api/v1/query" \
  --data-urlencode "query=sum(increase(http_requests_total{status=~\"5..\"}[${WINDOW_DAYS}d]))" \
  | jq -r '.data.result[0].value[1]' | cut -d. -f1)

BUDGET_REMAINING=$(echo "$ERROR_BUDGET_REQUESTS - $CURRENT_ERRORS" | bc)
BUDGET_PERCENT_REMAINING=$(echo "scale=2; $BUDGET_REMAINING / $ERROR_BUDGET_REQUESTS * 100" | bc)

echo "Window: ${WINDOW_DAYS} days"
echo "Total requests: ${TOTAL_REQUESTS}"
echo "Error budget (requests): ${ERROR_BUDGET_REQUESTS}"
echo "Errors consumed: ${CURRENT_ERRORS}"
echo "Budget remaining: ${BUDGET_REMAINING} requests (${BUDGET_PERCENT_REMAINING}%)"
```

For a service handling 10M requests/month with a 99.5% SLO:
- Error budget = 50,000 failed requests per month
- That's ~1,667 failures per day you can "spend"
- Or ~70 per hour

Now you have real numbers. When someone asks "can we deploy on Friday?" you can answer: "We have 23,000 requests left in our error budget. The last deploy caused 500 errors. Yes, we can deploy."

## Set Up Automated Burn Rate Alerts

Raw error counts are useless for alerting. You need burn rate — how fast you're consuming your budget.

A burn rate of 1.0 means you'll exactly exhaust your budget over your SLO window. A burn rate of 10.0 means you'll burn through your monthly budget in 3 days.

Here's a Prometheus alerting rule that actually works:

```yaml
# prometheus-rules/slo-alerts.yaml
groups:
  - name: slo-alerts
    rules:
      # Calculate error rate
      - record: http_requests:error_rate:ratio_rate5m
        expr: |
          sum(rate(http_requests_total{status=~"5.."}[5m]))
          /
          sum(rate(http_requests_total[5m]))

      # Fast burn - will exhaust 30-day budget in 2 days
      # Burn rate > 14.4 for 5 minutes = page immediately
      - alert: SLOFastBurn
        expr: |
          (
            sum(rate(http_requests_total{status=~"5.."}[5m]))
            /
            sum(rate(http_requests_total[5m]))
          ) > (14.4 * 0.005)  # 14.4x burn rate * error budget
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Fast error budget burn - exhausted in <2 days at current rate"
          runbook: "https://wiki/slo-fastburn-runbook"

      # Slow burn - will exhaust budget in ~10 days
      # Burn rate > 3 for 1 hour = ticket
      - alert: SLOSlowBurn
        expr: |
          (
            sum(rate(http_requests_total{status=~"5.."}[1h]))
            /
            sum(rate(http_requests_total[1h]))
          ) > (3 * 0.005)  # 3x burn rate * error budget
        for: 30m
        labels:
          severity: warning
        annotations:
          summary: "Slow error budget burn - exhausted in <10 days at current rate"
          runbook: "https://wiki/slo-slowburn-runbook"

      # Budget status tracking
      - record: error_budget:remaining_percent
        expr: |
          1 - (
            sum(increase(http_requests_total{status=~"5.."}[30d]))
            /
            (sum(increase(http_requests_total[30d])) * 0.005)
          )
```

The key insight: two alerts at different time scales catch different problems. Fast burn catches incidents. Slow burn catches gradual degradation that nobody notices until the budget is gone.

## Build a Dashboard That Drives Decisions

Your SLO dashboard should answer one question: "Can we ship today?"

```yaml
# grafana-dashboard.json (relevant panel configs)
panels:
  - title: "Error Budget Remaining"
    type: "gauge"
    targets:
      - expr: "error_budget:remaining_percent * 100"
    fieldConfig:
      thresholds:
        - color: "green"
          value: 50
        - color: "yellow"
          value: 25
        - color: "red"
          value: 0

  - title: "Budget Burn Rate (last hour)"
    type: "stat"
    targets:
      - expr: |
          (
            sum(rate(http_requests_total{status=~"5.."}[1h]))
            /
            sum(rate(http_requests_total[1h]))
          ) / 0.005  # Divide by error budget to get burn rate

  - title: "Days Until Budget Exhausted"
    type: "stat"
    targets:
      - expr: |
          30 * error_budget:remaining_percent
          /
          (
            (sum(rate(http_requests_total{status=~"5.."}[6h]))
            / sum(rate(http_requests_total[6h])))
            / 0.005
          )
```

Put this dashboard on a TV in the team area. When someone sees "4 days until budget exhausted," conversations happen naturally.

## Make the Budget Mean Something

Here's where most SLO implementations fail: the error budget has no teeth.

Define concrete policies:

**Budget > 50%:** Normal operations. Deploy at will. Run experiments.

**Budget 25-50%:** Caution. All changes need extra review. No experiments on production.

**Budget < 25%:** Restricted. Emergency changes only. All hands on reliability.

**Budget exhausted:** Freeze. No feature deployments. Team focuses entirely on reliability until budget is replenished.

Put this in your CI/CD:

```bash
#!/bin/bash
# pre-deploy-check.sh

BUDGET_REMAINING=$(curl -s "http://prometheus:9090/api/v1/query" \
  --data-urlencode 'query=error_budget:remaining_percent' \
  | jq -r '.data.result[0].value[1]')

BUDGET_PERCENT=$(echo "$BUDGET_REMAINING * 100" | bc)

if (( $(echo "$BUDGET_PERCENT < 0" | bc -l) )); then
  echo "❌ ERROR BUDGET EXHAUSTED. Deployment blocked."
  echo "Current budget: ${BUDGET_PERCENT}%"
  exit 1
elif (( $(echo "$BUDGET_PERCENT < 25" | bc -l) )); then
  echo "⚠️  LOW ERROR BUDGET. Deployment requires approval."
  echo "Current budget: ${BUDGET_PERCENT}%"
  # Post to Slack, require manual approval, etc.
  exit 2
else
  echo "✅ Error budget healthy: ${BUDGET_PERCENT}%"
  exit 0
fi
```

## Making It Stick

The hardest part isn't the technical implementation — it's getting buy-in. Here's what works:

Start with one service. Pick something with clear ownership and enough traffic to make the numbers meaningful (at least 10k requests/day). Get that team using error budgets for 3 months before expanding.

Show the value with specific examples: "Last quarter we spent 40 hours debugging production issues. With error budgets, we caught 3 problems before they became incidents because slow burn alerts triggered."

Review budgets weekly. In your team standup, spend 30 seconds on: "We're at 67% budget, burned 2% this week, no action needed." This makes SLOs part of the team's vocabulary.

Your next step: Run that first Prometheus query against your actual metrics right now. Find out your current reliability number. That's your baseline. Set your first SLO 0.5% below that, configure the fast-burn alert, and you've got a working SLO implementation by end of week.