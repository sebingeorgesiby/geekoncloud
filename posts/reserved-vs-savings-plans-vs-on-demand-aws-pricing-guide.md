---
title: "Reserved vs Savings Plans vs On-Demand: AWS Cost Guide 2024"
date: 2026-09-07
excerpt: "Cut AWS bills 40-72% with the right pricing model. Real calculations, break-even math, and decision framework from production workloads."
tags: ["aws","cost-optimization","finops","cloud-infrastructure","savings-plans"]
author: GeekOnCloud
draft: false
---

The moment your AWS bill crosses $10k/month, the "just use on-demand" strategy stops being acceptable. You're literally burning money — anywhere from 30% to 72% of your compute spend — that could be reclaimed with zero architectural changes. Yet I still see teams running $50k+ workloads entirely on-demand because "reserved instances are complicated" or "we might scale down." Let's fix that.

## The Real Cost Difference (With Actual Numbers)

Before we get into strategy, let's ground this with concrete pricing. Taking `m6i.xlarge` in `us-east-1` as a reference:

| Pricing Model | Hourly Cost | Monthly (730 hrs) | Annual | Savings vs On-Demand |
|---------------|-------------|-------------------|--------|---------------------|
| On-Demand | $0.192 | $140.16 | $1,681.92 | - |
| 1yr Savings Plan (No Upfront) | $0.121 | $88.33 | $1,059.96 | 37% |
| 1yr Savings Plan (All Upfront) | $0.115 | $83.95 | $1,007.40 | 40% |
| 3yr Savings Plan (All Upfront) | $0.077 | $56.21 | $674.52 | 60% |
| 3yr Reserved Instance (All Upfront) | $0.073 | $53.29 | $639.48 | 62% |

That 62% savings on a single instance becomes $1,042/year. Multiply by 50 instances — that's $52,000 annually you're either keeping or throwing away.

## When On-Demand Actually Makes Sense

On-demand isn't always wrong. Use it when:

**1. Genuine unpredictability**: You're a startup in growth mode with usage swinging 3x month-over-month. Committing now means either over-provisioning or constantly adjusting commitments.

**2. Burst workloads under 30% utilization**: If your average utilization is below the break-even point (~30% for 1yr commitments), on-demand wins. Here's how to check your actual utilization:

```bash
# Get average CPU utilization across all EC2 instances for the past 30 days
aws cloudwatch get-metric-statistics \
  --namespace AWS/EC2 \
  --metric-name CPUUtilization \
  --dimensions Name=InstanceId,Value=i-0abc123def456 \
  --start-time $(date -u -d '30 days ago' +%Y-%m-%dT%H:%M:%SZ) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ) \
  --period 86400 \
  --statistics Average \
  --query 'Datapoints[*].[Timestamp,Average]' \
  --output table

# Or use Cost Explorer for aggregate view
aws ce get-cost-and-usage \
  --time-period Start=$(date -d '30 days ago' +%Y-%m-%d),End=$(date +%Y-%m-%d) \
  --granularity DAILY \
  --metrics UsageQuantity \
  --group-by Type=DIMENSION,Key=INSTANCE_TYPE \
  --filter '{"Dimensions":{"Key":"SERVICE","Values":["Amazon Elastic Compute Cloud - Compute"]}}'
```

**3. Short-lived projects**: Anything under 6 months doesn't justify even 1-year commitments. The break-even for a 1yr No Upfront Savings Plan is roughly 7-8 months.

**4. Testing instance types**: When evaluating Graviton migration or new instance families, run on-demand for 2-4 weeks before committing.

## Reserved Instances: Maximum Savings, Maximum Constraints

Reserved Instances (RIs) offer the deepest discounts but come with real constraints. Here's when they're the right choice:

**Use Standard RIs when:**
- You have stable, predictable workloads (databases, core application servers)
- You're committed to a specific instance type and region
- You're willing to manage the RI lifecycle (selling unused capacity on the marketplace)

**Use Convertible RIs when:**
- You need instance family flexibility
- You're planning architecture changes but want commitment savings

The key decision point: **RIs are tied to specific instance families within a region**. A `c6i.xlarge` RI won't cover a `c7i.xlarge` (unless convertible). Savings Plans don't have this problem.

Here's a Terraform module I use to track RI coverage and alert on gaps:

```hcl
# reserved_instance_monitoring.tf

resource "aws_cloudwatch_metric_alarm" "ri_coverage_low" {
  alarm_name          = "reserved-instance-coverage-low"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Coverage"
  namespace           = "AWS/Billing"
  period              = 86400
  statistic           = "Average"
  threshold           = 80
  alarm_description   = "RI coverage dropped below 80% - review for commitment opportunities"
  
  dimensions = {
    Service = "Amazon Elastic Compute Cloud - Compute"
  }
  
  alarm_actions = [aws_sns_topic.finops_alerts.arn]
}

resource "aws_budgets_budget" "ri_utilization" {
  name         = "ri-utilization-alert"
  budget_type  = "RI_UTILIZATION"
  limit_amount = "100"
  limit_unit   = "PERCENTAGE"
  time_unit    = "MONTHLY"

  cost_filter {
    name   = "Service"
    values = ["Amazon Elastic Compute Cloud - Compute"]
  }

  notification {
    comparison_operator       = "LESS_THAN"
    threshold                 = 90
    threshold_type           = "PERCENTAGE"
    notification_type        = "ACTUAL"
    subscriber_email_addresses = ["finops@company.com"]
  }
}

# Output current RI inventory for drift detection
data "aws_ec2_reserved_instances_offerings" "current" {
  filter {
    name   = "scope"
    values = ["Region"]
  }
}
```

## Savings Plans: The Modern Default

For most organizations, **Compute Savings Plans should be your default commitment vehicle**. Here's why:

1. **Instance flexibility**: Covers any instance family, size, OS, tenancy, or region
2. **Graviton-ready**: Switch from `m6i` to `m7g` without losing coverage
3. **Cross-service**: Covers EC2, Fargate, and Lambda
4. **Simpler management**: No marketplace, no modifications, just hourly commitment

The strategy I recommend for teams starting out:

```
1. Pull 30-day on-demand spend: ~$50,000
2. Calculate baseline (lowest daily spend): ~$1,200/day
3. Convert baseline to hourly commitment: $1,200 / 24 = $50/hr
4. Start with 70% of baseline in Savings Plans: $35/hr commitment
5. Reassess in 90 days, increase if utilization > 95%
```

**EC2 Instance Savings Plans** offer ~2-3% deeper discounts than Compute Savings Plans but lock you to instance families. Use them only for workloads you're certain won't change (RDS-like patterns on EC2, legacy systems).

## The Hybrid Strategy That Actually Works

Here's the commitment strategy I've deployed at companies running $100k-$500k monthly EC2 spend:

**Layer 1 — Compute Savings Plans (60-70% of baseline)**: 3-year commitments on your absolute floor. This is compute that runs 24/7/365: databases, core services, Kubernetes node minimums.

**Layer 2 — EC2 Instance Savings Plans (15-20% of baseline)**: 1-year commitments on stable instance families. Your production cluster nodes that might scale but won't change architecture.

**Layer 3 — On-Demand + Spot (remaining 15-25%)**: Variable workloads, dev/test environments, burst capacity.

```bash
# Calculate your commitment layers using Cost Explorer
aws ce get-reservation-coverage \
  --time-period Start=2024-01-01,End=2024-12-01 \
  --granularity MONTHLY \
  --group-by Type=DIMENSION,Key=INSTANCE_TYPE \
  --filter '{"Dimensions":{"Key":"REGION","Values":["us-east-1"]}}' \
  --output json | jq '.CoveragesByTime[].Groups[] | 
    select(.Coverage.CoverageHours.CoverageHoursPercentage | tonumber < 80) |
    {instance: .Attributes.instanceType, coverage: .Coverage.CoverageHours.CoverageHoursPercentage}'
```

This query shows you instance types with less than 80% coverage — your immediate optimization targets.

## The Commitment Ladder

Don't go from zero to 3-year all-upfront overnight. Use this progression:

**Month 1-3**: 1-year No Upfront Savings Plans at 50% of baseline. This gives you escape velocity if assumptions are wrong.

**Month 4-6**: Analyze utilization. If >95%, increase to 70% of current baseline.

**Month 7-12**: Convert proven stable workloads to 3-year. Keep 1-year for everything else.

**Annually**: Review instance family adoption. Convert Compute SP to EC2 Instance SP where patterns are stable.

The goal isn't maximum savings — it's **optimal savings with acceptable risk**. A 3-year all-upfront commitment saving 62% is worthless if you migrate to Graviton in year 2 and leave money on the table.

## Your Next Move

Open Cost Explorer right now. Navigate to Savings Plans → Recommendations. AWS will show you a recommended hourly commitment based on your usage patterns. Take that number, multiply by 0.7, and that's your safe starting commitment. Purchase a 1-year Compute Savings Plan with no upfront payment. You'll start saving 30%+ tomorrow with minimal risk. In 90 days, revisit and increase based on actual utilization data — not assumptions.