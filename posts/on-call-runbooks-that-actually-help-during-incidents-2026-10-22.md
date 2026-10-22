---
title: "On-Call Runbooks That Actually Work: A Practical Guide"
date: 2026-10-22
excerpt: "Stop writing useless runbooks. Learn the exact structure, commands, and decision trees that help engineers resolve incidents at 3am under pressure."
tags: ["incident-response","on-call","runbooks","sre","observability"]
author: GeekOnCloud
draft: false
---

Most runbooks are where good intentions go to die. They start as a heroic post-incident effort, get dumped into a wiki, and slowly rot until someone opens them at 3 AM only to discover they reference a service that was deprecated eighteen months ago.

I've been on both ends of this — the engineer frantically scrolling through a useless document while alerts scream, and the one writing runbooks that nobody ever reads. After years of refining the process, I've landed on patterns that actually work when everything's on fire.

## The Anatomy of a Runbook That Gets Used

The biggest mistake teams make is treating runbooks like documentation. They're not. Documentation explains *how things work*. Runbooks tell you *what to do right now* when things don't work.

A useful runbook has exactly three sections that matter:

**Detection** — How do you know this is actually the problem the runbook addresses?
**Mitigation** — What's the fastest path to stopping the bleeding?
**Resolution** — How do you actually fix it once the pressure's off?

Everything else is noise during an incident. Put your architecture explanations, historical context, and ownership details elsewhere.

Here's the template I use:

```markdown
# [SERVICE] - [SYMPTOM]

## Quick Check (< 30 seconds)
- [ ] Check if this matches: `curl -s https://api.internal/health | jq .database`
- [ ] Expected: `{"status": "healthy", "latency_ms": < 100}`
- [ ] If latency > 500ms or status != healthy, this runbook applies

## Immediate Mitigation (< 5 minutes)
1. Scale read replicas: `kubectl scale deployment/api-reader --replicas=10`
2. Enable circuit breaker: `curl -X POST https://api.internal/admin/circuit/database/open`
3. Verify traffic shifted: `watch 'kubectl get pods -l app=api-reader'`

## Resolution
See: [Database Connection Pool Tuning](#full-resolution)

## Escalation
- Primary: @database-oncall (PagerDuty)
- Secondary: Jane Smith (jane@company.com, +1-555-0123)
- Vendor support: AWS case via console (account: prod-main)
```

Notice what's not there: no explanation of what a circuit breaker is, no history of why we have read replicas, no architecture diagrams. That's all useful — just not at 3 AM.

## Automate the Boring Parts

Every runbook step that says "check the logs" or "verify the metric" should have a command that does exactly that. Vague instructions create cognitive load when you have none to spare.

I maintain a companion script repository alongside our runbooks. Here's a real example for our PostgreSQL connection exhaustion scenario:

```bash
#!/bin/bash
# pg-connection-check.sh
# Runbook companion: https://wiki.internal/runbooks/pg-connections

set -euo pipefail

DB_HOST="${1:-prod-primary.db.internal}"
WARN_THRESHOLD="${2:-80}"
CRIT_THRESHOLD="${3:-95}"

# Get current connection stats
CONN_STATS=$(psql -h "$DB_HOST" -U monitoring -d postgres -t -A -c "
SELECT 
    count(*) as total,
    count(*) FILTER (WHERE state = 'active') as active,
    count(*) FILTER (WHERE state = 'idle') as idle,
    count(*) FILTER (WHERE state = 'idle in transaction') as idle_txn,
    (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') as max
FROM pg_stat_activity
WHERE backend_type = 'client backend';
")

IFS='|' read -r TOTAL ACTIVE IDLE IDLE_TXN MAX <<< "$CONN_STATS"
USAGE_PCT=$((TOTAL * 100 / MAX))

echo "=== Connection Status for $DB_HOST ==="
echo "Total: $TOTAL / $MAX ($USAGE_PCT%)"
echo "Active: $ACTIVE | Idle: $IDLE | Idle in Transaction: $IDLE_TXN"

if [ "$USAGE_PCT" -ge "$CRIT_THRESHOLD" ]; then
    echo ""
    echo "🚨 CRITICAL: Connection usage above ${CRIT_THRESHOLD}%"
    echo ""
    echo "Top connection sources:"
    psql -h "$DB_HOST" -U monitoring -d postgres -c "
    SELECT client_addr, usename, application_name, count(*) 
    FROM pg_stat_activity 
    WHERE backend_type = 'client backend'
    GROUP BY 1,2,3 
    ORDER BY 4 DESC 
    LIMIT 10;"
    echo ""
    echo "Recommended actions:"
    echo "1. Terminate idle-in-transaction: pg-kill-idle-txn.sh $DB_HOST"
    echo "2. Scale API pods to reduce per-host connections"
    echo "3. Enable PgBouncer if not already active"
    exit 2
elif [ "$USAGE_PCT" -ge "$WARN_THRESHOLD" ]; then
    echo "⚠️  WARNING: Connection usage above ${WARN_THRESHOLD}%"
    exit 1
fi

echo "✅ Connection usage healthy"
exit 0
```

This script gets linked directly in the runbook. The on-call engineer doesn't need to remember psql syntax or which columns matter — they run one command and get actionable output.

## Keep Runbooks Honest with Automated Testing

Runbooks decay faster than any other documentation because systems change constantly. The database got renamed, the kubectl context is different, the monitoring endpoint moved.

The only reliable solution is treating runbooks as code and testing them regularly:

```yaml
# .github/workflows/runbook-validation.yml
name: Validate Runbooks

on:
  schedule:
    - cron: '0 9 * * 1'  # Every Monday at 9 AM
  workflow_dispatch:

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Install dependencies
        run: |
          pip install markdown-link-validator
          
      - name: Check for broken internal links
        run: |
          find runbooks/ -name "*.md" -exec markdown-link-validator {} \;
          
      - name: Verify referenced scripts exist
        run: |
          grep -roh 'scripts/[a-z0-9_-]*\.sh' runbooks/ | sort -u | while read script; do
            if [ ! -f "$script" ]; then
              echo "ERROR: Missing script referenced in runbook: $script"
              exit 1
            fi
          done
          
      - name: Dry-run critical scripts (staging)
        env:
          KUBECONFIG: ${{ secrets.STAGING_KUBECONFIG }}
        run: |
          # Only scripts marked as safe for dry-run testing
          for script in scripts/*-check.sh; do
            echo "Testing: $script"
            bash "$script" --dry-run staging || exit 1
          done
          
      - name: Verify escalation contacts
        run: |
          # Check that PagerDuty schedules still exist
          python scripts/validate-escalation-paths.py runbooks/
```

This catches the obvious stuff: dead links, missing scripts, renamed services. For deeper validation, I have teams run quarterly "runbook fire drills" where someone picks a random runbook and follows it against a staging environment. If any step is unclear or broken, it gets fixed immediately.

## The One-Pager Rule

Here's a hard rule I enforce: if a runbook can't fit on a single printed page (roughly 50 lines of markdown), it's too complex. Either the problem needs to be broken into multiple runbooks, or the mitigation steps need automation.

When engineers push back on this, I ask: "Would you want to read beyond page one at 3 AM with your phone buzzing?" The answer is always no.

Long runbooks are a symptom of one of two issues:

1. **The service is too complex** — Break it into smaller failure domains with dedicated runbooks
2. **The runbook is doing too much** — Separate investigation from mitigation. Have a quick mitigation runbook and link to detailed troubleshooting guides

The goal isn't comprehensive documentation. It's getting the system stable fast enough that everyone can go back to sleep — and then doing proper root cause analysis during business hours.

## The Real Measure of Success

Good runbooks have a measurable impact: shorter incident duration, fewer escalations, less context-switching during pages. Track these metrics and review them monthly.

Your next step: pick your three most common alert types from the last quarter. Write runbooks for them using this structure, automate at least two diagnostic commands per runbook, and schedule a monthly validation job. In three months, measure your mean time to mitigation and compare. The numbers don't lie.