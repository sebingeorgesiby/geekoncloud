---
title: "Rightsizing EC2 Instances with AWS Compute Optimizer"
date: 2026-10-30
excerpt: "Cut EC2 costs 30-40% using Compute Optimizer recommendations. Real commands, CloudWatch queries, and automation scripts for production workloads."
tags: ["AWS","EC2","Cost Optimization","Compute Optimizer","Cloud Infrastructure"]
author: GeekOnCloud
draft: false
---

You're probably overpaying for EC2 by 30-40%. Not because you're careless, but because instance selection is genuinely hard. You picked a size during a launch, traffic patterns changed, and now you've got a fleet of m5.xlarge instances averaging 12% CPU utilization. AWS Compute Optimizer exists to fix exactly this problem—and unlike most AWS cost tools, it actually works well.

## What Compute Optimizer Actually Does

Compute Optimizer analyzes 14 days of CloudWatch metrics—CPU, memory (if you have the agent), network, and disk I/O—then runs them through machine learning models to recommend right-sized instances. It's not just "your CPU is low, go smaller." The algorithm considers burstable vs. fixed performance, considers your utilization patterns (spiky vs. steady), and even factors in regional pricing.

The service covers EC2 instances, EBS volumes, Lambda functions, and ECS services on Fargate. For this post, I'm focusing on EC2 because that's where most waste lives.

Before you do anything else, enable it:

```bash
# Enable Compute Optimizer for your account
aws compute-optimizer update-enrollment-status \
    --status Active \
    --include-member-accounts

# Verify it's enabled
aws compute-optimizer get-enrollment-status

# For Organizations, enable from management account
aws compute-optimizer update-enrollment-status \
    --status Active \
    --include-member-accounts
```

Give it 24-48 hours to start generating recommendations, though the best insights come after the full 14-day analysis window.

## Reading the Recommendations Correctly

Compute Optimizer categorizes instances into four finding types: Under-provisioned, Over-provisioned, Optimized, and Not Optimized. That last one means it doesn't have enough data or the instance type isn't supported (looking at you, previous-gen instances).

Pull recommendations programmatically—the console is fine for browsing, but you need this in your workflow:

```bash
# Get all EC2 recommendations in JSON
aws compute-optimizer get-ec2-instance-recommendations \
    --region us-east-1 \
    --output json > recommendations.json

# Filter for over-provisioned instances with high savings
aws compute-optimizer get-ec2-instance-recommendations \
    --filters "name=Finding,values=Overprovisioned" \
    --region us-east-1 \
    --query 'instanceRecommendations[?recommendationOptions[0].projectedUtilizationMetrics[0].value < `30`].[instanceArn,currentInstanceType,recommendationOptions[0].instanceType,recommendationOptions[0].estimatedMonthlySavings.value]' \
    --output table
```

Each recommendation comes with up to three options ranked by risk tolerance. Option 1 is the conservative choice (similar performance, moderate savings), Option 3 is aggressive (maximum savings, requires validation). The `performanceRisk` score ranges from 0-5—anything above 3 means you're likely to hit performance issues.

Here's what the output looks like in practice. A typical over-provisioned finding:

```json
{
  "instanceArn": "arn:aws:ec2:us-east-1:123456789:instance/i-0abc123def456",
  "currentInstanceType": "m5.2xlarge",
  "finding": "Overprovisioned",
  "utilizationMetrics": [
    {"name": "CPU", "statistic": "Maximum", "value": 23.5},
    {"name": "Memory", "statistic": "Maximum", "value": 31.2}
  ],
  "recommendationOptions": [
    {
      "instanceType": "m5.large",
      "performanceRisk": 1.2,
      "estimatedMonthlySavings": {"currency": "USD", "value": 142.56}
    }
  ]
}
```

That's a 4x downsize suggestion—m5.2xlarge (8 vCPU, 32GB) to m5.large (2 vCPU, 8GB). The low performance risk score means this instance genuinely doesn't need the capacity.

## Enhanced Infrastructure Metrics: Memory Matters

By default, Compute Optimizer only sees what CloudWatch sees—and CloudWatch doesn't collect memory metrics without the agent. This is a massive blind spot. An instance can show 15% CPU but be swapping to disk because it's memory-constrained.

Enable enhanced metrics by deploying the CloudWatch agent:

```yaml
# cloudwatch-agent-config.json
{
  "metrics": {
    "namespace": "CWAgent",
    "metrics_collected": {
      "mem": {
        "measurement": ["mem_used_percent"],
        "metrics_collection_interval": 60
      },
      "disk": {
        "measurement": ["disk_used_percent"],
        "resources": ["/", "/data"],
        "metrics_collection_interval": 60
      },
      "netstat": {
        "measurement": ["tcp_established", "tcp_time_wait"],
        "metrics_collection_interval": 60
      }
    }
  }
}
```

Deploy with SSM Run Command across your fleet:

```bash
# Install and configure CloudWatch agent via SSM
aws ssm send-command \
    --document-name "AWS-ConfigureAWSPackage" \
    --targets "Key=tag:Environment,Values=production" \
    --parameters '{"action":["Install"],"name":["AmazonCloudWatchAgent"]}' \
    --region us-east-1

# Then configure it
aws ssm send-command \
    --document-name "AmazonCloudWatch-ManageAgent" \
    --targets "Key=tag:Environment,Values=production" \
    --parameters '{"action":["configure"],"optionalConfigurationSource":["ssm"],"optionalConfigurationLocation":["AmazonCloudWatch-linux-config"]}' \
    --region us-east-1
```

After enabling enhanced metrics, Compute Optimizer needs another 14 days to incorporate memory data. The recommendations improve dramatically—I've seen the confidence scores jump from 60% to 90%+ once memory visibility is added.

## Building a Rightsizing Pipeline

Don't manually act on these recommendations. Build a pipeline that surfaces high-confidence opportunities for review:

```bash
#!/bin/bash
# weekly-rightsizing-report.sh

REGIONS=("us-east-1" "us-west-2" "eu-west-1")
THRESHOLD_SAVINGS=50  # Minimum monthly savings to report
THRESHOLD_RISK=2      # Maximum acceptable performance risk

for REGION in "${REGIONS[@]}"; do
    echo "=== Region: $REGION ===" 
    
    aws compute-optimizer get-ec2-instance-recommendations \
        --region "$REGION" \
        --filters "name=Finding,values=Overprovisioned" \
        --query "instanceRecommendations[?recommendationOptions[0].estimatedMonthlySavings.value >= \`$THRESHOLD_SAVINGS\` && recommendationOptions[0].performanceRisk <= \`$THRESHOLD_RISK\`].{
            Instance: instanceArn,
            Current: currentInstanceType,
            Recommended: recommendationOptions[0].instanceType,
            MonthlySavings: recommendationOptions[0].estimatedMonthlySavings.value,
            Risk: recommendationOptions[0].performanceRisk
        }" \
        --output table
done
```

Run this weekly via cron or EventBridge. Pipe the output to Slack or create Jira tickets automatically. The key is making rightsizing a recurring process, not a one-time cleanup.

## Implementing Changes Safely

Never resize production instances without validation. My approach:

1. **Clone and test**: Launch the recommended instance type with the same AMI, run your test suite
2. **Canary deployment**: If using ASGs, create a mixed instances policy with 10% of the new type
3. **Monitor for 48 hours**: Watch latency percentiles (p99 matters more than average), error rates, and the metrics Compute Optimizer flagged
4. **Full rollout**: Update your launch template and cycle instances

For Auto Scaling Groups, Terraform makes the mixed approach easy:

```hcl
resource "aws_autoscaling_group" "web" {
  name                = "web-asg"
  desired_capacity    = 10
  max_size            = 20
  min_size            = 5

  mixed_instances_policy {
    instances_distribution {
      on_demand_percentage_above_base_capacity = 30
      spot_allocation_strategy                 = "capacity-optimized"
    }

    launch_template {
      launch_template_specification {
        launch_template_id = aws_launch_template.web.id
        version            = "$Latest"
      }

      override {
        instance_type = "m5.xlarge"  # Current
        weighted_capacity = 1
      }

      override {
        instance_type = "m5.large"   # Recommended
        weighted_capacity = 1
      }
    }
  }
}
```

## The Exceptions: When to Ignore Recommendations

Compute Optimizer isn't omniscient. Ignore or heavily scrutinize recommendations when:

- **Batch workloads**: If an instance runs at 5% CPU for 23 hours then 100% for 1 hour during nightly processing, the recommendation will be wrong
- **Seasonal patterns**: 14 days might not capture your Black Friday traffic
- **Memory-intensive workloads without the agent**: Redis, Elasticsearch, JVM-heavy apps—the recommendation is blind without memory metrics
- **Instances newer than 14 days**: Insufficient data, period

Check the `lookBackPeriodInDays` field in recommendations. If it's less than 14, wait.

Start with your largest instances—that's where the biggest savings hide. A single m5.4xlarge running at 20% utilization costs you $560/month. Right-size it to m5.xlarge and you've paid for an engineer's coffee budget for the year. Run the report script above, pick the three highest-savings instances with risk scores under 2, and resize them this week.