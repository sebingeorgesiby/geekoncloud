---
title: "Post-Mortems That Actually Fix Things: Template & Process"
date: 2026-06-28
excerpt: "Stop writing post-mortems that gather dust. A battle-tested template and process that turns incidents into lasting infrastructure improvements."
tags: ["incident-management","sre","devops-culture","reliability"]
author: GeekOnCloud
draft: false
---

The incident is over. Services are back up. Everyone's exhausted. And now comes the part most teams get wrong: the post-mortem. I've seen hundreds of post-mortem documents that read like liability shields — vague timelines, passive voice everywhere, and action items that never get touched. Then six months later, the same incident happens again.

A post-mortem that drives real change isn't a document — it's a forcing function. Here's the template and process I've refined over eight years of running incident response at three different companies.

## Why Most Post-Mortems Fail

The typical post-mortem dies in one of three ways:

1. **Blame-focused**: "The engineer pushed bad code" — which teaches nothing and ensures future incidents get hidden
2. **Too vague**: "Improve monitoring" as an action item with no owner, deadline, or definition of done
3. **Never referenced**: Written, filed, forgotten — no mechanism to track whether changes actually happened

The goal isn't documentation. The goal is reducing repeat incidents by at least 50% within the same category. If your post-mortems aren't achieving that, they're theater.

## The Template That Actually Works

I've open-sourced variations of this template at every company I've worked at. Here's the core structure in a format you can drop into your wiki:

```markdown
# Incident Post-Mortem: [YYYY-MM-DD] [Brief Description]

## Metadata
- **Severity**: SEV1/SEV2/SEV3
- **Duration**: [Start time] to [End time] ([X] minutes/hours)
- **Affected Systems**: [List specific services]
- **Customer Impact**: [Quantified: X users, Y% of traffic, $Z revenue]
- **Detection Method**: Monitoring alert / Customer report / Internal discovery
- **Time to Detect (TTD)**: [X] minutes
- **Time to Mitigate (TTM)**: [X] minutes
- **Lead Author**: [Name]
- **Review Date**: [Date of post-mortem meeting]

## Executive Summary
[2-3 sentences. What happened, what was the impact, what's the single most important fix.]

## Timeline
| Time (UTC) | Event |
|------------|-------|
| 14:32 | Deployment X rolled out to production |
| 14:47 | First error spike in Datadog |
| 14:52 | PagerDuty alert fires to on-call |
| ... | ... |

## Root Cause Analysis
[Use the "5 Whys" method. Be specific about the technical failure AND the process failure that allowed it.]

### Technical Root Cause
[Specific: "Connection pool exhausted because pg_bouncer max_client_conn was set to 100 while the application spawned 150 connections per pod"]

### Process Root Cause  
[Specific: "Load testing environment uses different pg_bouncer config than production, so this wasn't caught pre-deploy"]

## Contributing Factors
- [Factor 1]: [How it contributed]
- [Factor 2]: [How it contributed]
- [Factor 3]: [How it contributed]

## What Went Well
- [Specific thing that worked]
- [Specific thing that worked]

## What Went Poorly
- [Specific thing that failed or was slow]
- [Specific thing that failed or was slow]

## Action Items
| Priority | Action | Owner | Deadline | Tracking Issue |
|----------|--------|-------|----------|----------------|
| P0 | [Specific, measurable action] | @name | YYYY-MM-DD | JIRA-1234 |
| P1 | [Specific, measurable action] | @name | YYYY-MM-DD | JIRA-1235 |
| P2 | [Specific, measurable action] | @name | YYYY-MM-DD | JIRA-1236 |

## Lessons Learned
[What should change about how we build/deploy/monitor systems based on this incident?]
```

The critical pieces: **quantified impact**, **specific root causes** (both technical and process), and **action items with deadlines and owners**. An action item without a Jira ticket doesn't exist.

## The 48-Hour Process

Timing matters. Here's the cadence that produces useful output without dragging on forever:

**Hour 0-4 (Immediate)**: Incident commander creates the post-mortem doc from template, fills in metadata and timeline while memory is fresh. This happens before anyone goes home.

**Hour 4-24 (Investigation)**: Async. Relevant engineers add technical details, dig into logs, update the timeline. No meetings yet.

**Hour 24-48 (Review Meeting)**: 60-minute meeting with everyone involved. The agenda:
- 10 min: Read the doc silently (yes, in the meeting — people won't read it beforehand)
- 20 min: Timeline corrections and additions
- 20 min: Root cause discussion and "5 Whys"
- 10 min: Define action items with owners and deadlines

**Hour 48+**: Doc is finalized and shared broadly. Action items are tracked in your sprint process.

Here's a script I use to automate the initial doc creation from PagerDuty incident data:

```bash
#!/bin/bash
# create-postmortem.sh - Generate post-mortem template from PagerDuty incident

INCIDENT_ID=$1
PD_API_KEY="${PAGERDUTY_API_KEY}"

if [ -z "$INCIDENT_ID" ]; then
    echo "Usage: ./create-postmortem.sh <incident_id>"
    exit 1
fi

# Fetch incident details from PagerDuty
INCIDENT=$(curl -s \
    -H "Authorization: Token token=${PD_API_KEY}" \
    -H "Content-Type: application/json" \
    "https://api.pagerduty.com/incidents/${INCIDENT_ID}?include[]=acknowledgers&include[]=assignees")

# Extract fields
TITLE=$(echo $INCIDENT | jq -r '.incident.title')
CREATED=$(echo $INCIDENT | jq -r '.incident.created_at')
RESOLVED=$(echo $INCIDENT | jq -r '.incident.last_status_change_at')
URGENCY=$(echo $INCIDENT | jq -r '.incident.urgency')
SERVICE=$(echo $INCIDENT | jq -r '.incident.service.summary')

# Calculate duration
START_EPOCH=$(date -d "$CREATED" +%s)
END_EPOCH=$(date -d "$RESOLVED" +%s)
DURATION_MIN=$(( (END_EPOCH - START_EPOCH) / 60 ))

# Generate filename
DATE=$(date -d "$CREATED" +%Y-%m-%d)
SLUG=$(echo "$TITLE" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g')
FILENAME="postmortems/${DATE}-${SLUG}.md"

mkdir -p postmortems

cat > "$FILENAME" << EOF
# Incident Post-Mortem: ${DATE} ${TITLE}

## Metadata
- **Severity**: $([ "$URGENCY" = "high" ] && echo "SEV1" || echo "SEV2")
- **Duration**: ${CREATED} to ${RESOLVED} (${DURATION_MIN} minutes)
- **Affected Systems**: ${SERVICE}
- **Customer Impact**: [TODO: Quantify]
- **Detection Method**: PagerDuty Alert
- **Time to Detect (TTD)**: [TODO] minutes
- **Time to Mitigate (TTM)**: ${DURATION_MIN} minutes
- **Lead Author**: [TODO]
- **Review Date**: $(date -d "+2 days" +%Y-%m-%d)

## Executive Summary
[TODO: 2-3 sentences]

## Timeline
| Time (UTC) | Event |
|------------|-------|
| ${CREATED} | Incident triggered |
| ${RESOLVED} | Incident resolved |

[TODO: Fill in detailed timeline]

## Root Cause Analysis
### Technical Root Cause
[TODO]

### Process Root Cause
[TODO]

## Contributing Factors
- [TODO]

## What Went Well
- [TODO]

## What Went Poorly
- [TODO]

## Action Items
| Priority | Action | Owner | Deadline | Tracking Issue |
|----------|--------|-------|----------|----------------|
| P0 | [TODO] | @TODO | $(date -d "+7 days" +%Y-%m-%d) | |

## Lessons Learned
[TODO]
EOF

echo "Created: $FILENAME"
echo "Review meeting suggested: $(date -d "+2 days" +%Y-%m-%d)"
```

## Tracking Action Items That Actually Get Done

The dirty secret: most post-mortem action items never get completed. Here's how to fix that.

**Embed in sprint planning**: Action items aren't special — they're work. They go in the backlog, get estimated, get scheduled. P0 items from post-mortems take priority over feature work. Full stop.

**Weekly review**: Every Monday, I run a query against our issue tracker to find overdue post-mortem action items. This goes to engineering leadership with zero commentary — the list speaks for itself.

**Quarterly metrics**: Track two numbers:
1. Percentage of post-mortem action items completed within deadline
2. Repeat incident rate (same root cause category within 6 months)

If your completion rate is below 80% or your repeat rate is above 20%, your process is broken.

## The Blameless Part Everyone Gets Wrong

"Blameless" doesn't mean "no accountability." It means we focus on **systems that allowed the failure** rather than **individuals who made mistakes**. 

The question isn't "who pushed the bad code?" — it's "why did our deployment pipeline allow bad code to reach production?"

Every human error is a process failure in disguise. The engineer who fat-fingered a config value isn't the root cause — the lack of validation, peer review, or automated checks is the root cause.

This isn't soft. It's pragmatic. Engineers who fear punishment hide information. Hidden information causes repeat incidents. Repeat incidents cost real money.

## What to Do Monday Morning

Pick your most recent SEV1 or SEV2 incident that doesn't have a complete post-mortem. Block 90 minutes on your calendar. Apply this template. Schedule the review meeting for 48 hours out. Create the Jira tickets for action items before you leave.

Then set a recurring calendar reminder: every Monday, check how many post-mortem action items are overdue. Share that number with your team. The visibility alone will drive completion rates up.

The template is the easy part. The discipline to complete action items and track repeat incidents — that's what separates teams that learn from teams that just document.