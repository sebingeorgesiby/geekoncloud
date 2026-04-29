---
title: On-Call Runbooks That Actually Work at 3AM
date: 2026-04-29
excerpt: Stop writing useless runbooks. Build incident docs with decision trees, copy-paste commands, and real escalation paths that save you at 3AM.
tags: ["incident-response","on-call","sre","runbooks","observability"]
author: GeekOnCloud
draft: false
---

Every engineer has lived this nightmare: 3 AM page, bleary-eyed SSH into production, frantically searching Confluence for that runbook someone wrote two years ago. You find it. Step 3 says "restart the service." Which service? On which host? With what flags? The runbook was written for infrastructure that no longer exists.

Most runbooks fail because they're written during calm retrospectives by people who've already forgotten the panic of the actual incident. They're documentation theater—they exist to satisfy audit requirements, not to help humans under stress.

Let's fix that.

## The Anatomy of a Useless Runbook

Before we build something better, let's diagnose why your current runbooks probably suck:

**They're prose-heavy.** Paragraphs explaining *why* something happens don't help at 3 AM. You need *what to do*.

**They assume context.** "Check the database" assumes you know which database, how to connect, and what "check" means.

**They're not executable.** Copy-pasting commands with `<PLACEHOLDER>` values wastes precious minutes.

**They rot.** The infrastructure changed six months ago, but the runbook still references the old monitoring stack.

**They're not tested.** Nobody has actually followed these steps during an incident since they were written.

Here's the test: hand your runbook to a new team member at 3 AM and watch them. If they have to ask questions or make assumptions, the runbook failed.

## Structure That Survives Stress

A runbook needs to work for a tired brain with elevated cortisol. Structure it like this:

```yaml
# runbook: database-connection-exhaustion
# last_tested: 2024-01-15
# owner: platform-team
# escalation: #incident-db in Slack, then page @db-oncall

severity: P1
symptoms:
  - "Connection pool exhausted" errors in app logs
  - Response times > 5s on /api endpoints
  - PostgreSQL active connections > 450 (limit: 500)

immediate_actions:
  - step: Verify the symptom
    command: |
      kubectl exec -it deploy/api-server -n production -- \
        curl -s localhost:8080/metrics | grep 'db_pool_active'
    expected: "db_pool_active should be near db_pool_max (100)"
    
  - step: Check PostgreSQL connections
    command: |
      psql $PROD_DB_URL -c "SELECT count(*), state FROM pg_stat_activity GROUP BY state;"
    expected: "idle connections < 50, active < 100"

  - step: Identify connection hogs
    command: |
      psql $PROD_DB_URL -c "
        SELECT pid, now() - pg_stat_activity.query_start AS duration, query, state
        FROM pg_stat_activity
        WHERE (now() - pg_stat_activity.query_start) > interval '5 minutes'
        ORDER BY duration DESC;"
    action_if_found: "Long-running queries indicate a stuck process. Proceed to kill step."

  - step: Kill stuck connections (ONLY if previous step shows > 10 idle-in-transaction)
    command: |
      psql $PROD_DB_URL -c "
        SELECT pg_terminate_backend(pid) 
        FROM pg_stat_activity 
        WHERE state = 'idle in transaction' 
        AND query_start < now() - interval '10 minutes';"
    rollback: "None needed - connections will be re-established by app pools"

mitigation_complete_when:
  - "db_pool_active drops below 80"
  - "API p99 latency < 500ms"
  - "No new 'Connection pool exhausted' errors for 5 minutes"

root_cause_investigation: "See postmortem template. Common causes: missing connection timeouts, leaked connections in error paths, sudden traffic spike."
```

Notice what's different:
- **Severity and escalation are at the top.** First decision: is this my problem or do I need to wake someone else?
- **Commands are complete.** No placeholders. Environment variables are named explicitly.
- **Each step has expected output.** You know if it worked.
- **Conditional actions.** "Only do X if Y" prevents overcorrection.
- **Clear completion criteria.** You know when to stop.

## Executable Runbooks: Beyond Documentation

The best runbooks aren't documents—they're scripts with documentation attached. Here's a pattern using a simple bash wrapper:

```bash
#!/usr/bin/env bash
# runbook-executor.sh - Interactive runbook runner
# Usage: ./runbook-executor.sh database-connection-exhaustion

set -euo pipefail

RUNBOOK_DIR="${RUNBOOK_DIR:-/opt/runbooks}"
LOG_FILE="/var/log/runbook-$(date +%Y%m%d-%H%M%S).log"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

confirm() {
    read -p "Execute: $1 [y/N/s(kip)] " -n 1 -r
    echo
    case $REPLY in
        y|Y) return 0 ;;
        s|S) return 2 ;;  # Skip
        *) echo "Aborting."; exit 1 ;;
    esac
}

run_step() {
    local description="$1"
    local command="$2"
    local expected="${3:-}"
    
    log "STEP: $description"
    echo "Command: $command"
    [[ -n "$expected" ]] && echo "Expected: $expected"
    
    if confirm "$command"; then
        log "EXECUTING: $command"
        eval "$command" 2>&1 | tee -a "$LOG_FILE"
        log "COMPLETED: $description"
        read -p "Did output match expected? [y/N] " -n 1 -r
        echo
        [[ $REPLY =~ ^[Yy]$ ]] || log "WARNING: Output did not match expected"
    elif [[ $? -eq 2 ]]; then
        log "SKIPPED: $description"
    fi
}

# Load runbook-specific steps
source "${RUNBOOK_DIR}/${1}.sh"

log "=== Runbook execution complete ==="
log "Log saved to: $LOG_FILE"
echo "Remember to create incident ticket and link this log."
```

Then your runbook becomes executable:

```bash
# /opt/runbooks/database-connection-exhaustion.sh

echo "=== Database Connection Exhaustion Runbook ==="
echo "Escalation: #incident-db in Slack, then page @db-oncall"
echo ""

run_step \
    "Verify connection pool saturation" \
    "kubectl exec -it deploy/api-server -n production -- curl -s localhost:8080/metrics | grep 'db_pool'" \
    "db_pool_active near db_pool_max indicates exhaustion"

run_step \
    "Check PostgreSQL connection states" \
    "psql \$PROD_DB_URL -c \"SELECT count(*), state FROM pg_stat_activity GROUP BY state;\"" \
    "idle < 50, active < 100 is healthy"

run_step \
    "Identify long-running queries" \
    "psql \$PROD_DB_URL -c \"SELECT pid, now() - query_start AS duration, left(query, 80), state FROM pg_stat_activity WHERE query_start < now() - interval '5 minutes' ORDER BY duration DESC LIMIT 10;\""

read -p "Found stuck connections to terminate? [y/N] " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    run_step \
        "Terminate idle-in-transaction connections older than 10 minutes" \
        "psql \$PROD_DB_URL -c \"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE state = 'idle in transaction' AND query_start < now() - interval '10 minutes';\"" \
        "Returns count of terminated connections"
fi

echo ""
echo "=== Verify mitigation ==="
echo "Check these metrics have recovered:"
echo "  - db_pool_active < 80"
echo "  - API p99 < 500ms"  
echo "  - No new 'Connection pool exhausted' errors for 5 minutes"
```

This approach gives you:
- **An audit trail.** Every step logged with timestamps.
- **Human confirmation.** No accidental automation of destructive steps.
- **Skip capability.** Jump past steps that don't apply.
- **Validation prompts.** Forces verification of each step's outcome.

## Keeping Runbooks Alive

Runbooks rot faster than any other documentation. Three practices keep them useful:

**1. Test them during game days.** Monthly, pick a runbook and have someone execute it against staging while you deliberately inject the failure. Treat failed steps as bugs.

**2. Link them to alerts.** Your PagerDuty/Opsgenie alert should include a direct link to the relevant runbook. If the alert doesn't map to a runbook, either the alert is noisy or you're missing documentation.

**3. Update during the incident.** This feels counterintuitive—you're firefighting, not writing docs. But add one line: "Step 3 didn't work because X. Did Y instead." Tomorrow's you will be grateful.

**4. Version control them.** Runbooks in Git mean you can see what changed, blame who changed it, and roll back bad updates. Confluence pages don't give you that.

## The Ownership Problem

Here's the uncomfortable truth: runbooks fail because nobody owns them. They're written once during onboarding or after a bad incident, then abandoned.

Assign every runbook an owner—not a team, a person. That person is responsible for:
- Testing it quarterly
- Updating it when infrastructure changes
- Being paged when someone else runs it and hits a problem

Add this to the runbook header. Make it part of your service catalog. When the owner changes teams, the runbook gets explicitly handed off or deprecated.

## Your First Step

Pick your noisiest alert from the last month. Write a runbook for it using the YAML structure above. Tomorrow, during business hours, have someone else on your team execute it while you watch. Don't help them—just take notes on where they get stuck.

Those notes are your backlog. Fix them, then move to the next alert.