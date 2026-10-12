---
title: "Port vs Backstage vs Cortex: IDP Tools Compared for 2024"
date: 2026-10-12
excerpt: "Real comparison of Port, Backstage, and Cortex IDPs. Setup complexity, pricing, extensibility, and which fits your team size and maturity."
tags: ["internal-developer-platform","backstage","platform-engineering","developer-experience","devops-tools"]
author: GeekOnCloud
draft: false
---

The Internal Developer Platform (IDP) market has exploded, and if you're tasked with evaluating tools, you've likely landed on the same shortlist everyone else has: Port, Backstage, and Cortex. I've deployed all three in production environments ranging from 50 to 500+ engineers. Here's what actually matters when choosing between them.

## The Core Philosophical Difference

Before diving into features, understand this: these tools solve the same problem from fundamentally different angles.

**Backstage** is an open-source framework. You're building your own IDP using Spotify's scaffolding. It's like getting a chassis and engine—you still need to build the car.

**Port** is a commercial platform with a data-model-first approach. You define your software catalog schema, and Port handles the rest. Think of it as a configurable product.

**Cortex** is a commercial platform focused on scorecards and service maturity. It's opinionated about what "good" looks like and pushes teams toward standards.

This distinction determines everything: deployment complexity, time-to-value, customization ceiling, and total cost.

## Deployment and Initial Setup

### Backstage

Backstage requires you to run infrastructure. Here's a minimal production setup:

```yaml
# backstage-values.yaml for Helm deployment
backstage:
  image:
    registry: ghcr.io
    repository: backstage/backstage
    tag: latest
  
  extraEnvVars:
    - name: POSTGRES_HOST
      value: "backstage-postgres.default.svc.cluster.local"
    - name: POSTGRES_PORT
      value: "5432"
    - name: GITHUB_TOKEN
      valueFrom:
        secretKeyRef:
          name: backstage-secrets
          key: github-token

postgresql:
  enabled: true
  auth:
    username: backstage
    database: backstage
  primary:
    persistence:
      size: 10Gi

ingress:
  enabled: true
  className: nginx
  host: backstage.internal.company.com
  tls:
    enabled: true
    secretName: backstage-tls
```

Expect 2-4 weeks to get a basic Backstage instance running with GitHub integration, basic catalog, and TechDocs. Add another 4-8 weeks for custom plugins, proper auth, and production hardening. You need at least one engineer maintaining it—Spotify has a team of 20+ on Backstage internally.

### Port and Cortex

Both are SaaS. You sign up, connect your GitHub/GitLab, and start configuring. Port's initial setup:

```bash
# Install Port's GitHub app, then bootstrap your catalog
curl -X POST "https://api.getport.io/v1/blueprints" \
  -H "Authorization: Bearer $PORT_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "identifier": "service",
    "title": "Service",
    "schema": {
      "properties": {
        "language": { "type": "string", "enum": ["go", "python", "node"] },
        "tier": { "type": "string", "enum": ["critical", "standard", "experimental"] },
        "oncall": { "type": "string", "format": "user" },
        "repo_url": { "type": "string", "format": "url" }
      },
      "required": ["language", "tier", "oncall"]
    }
  }'
```

Time-to-value: Port typically gets you a working catalog in 1-2 weeks. Cortex is similar, with scorecards live in 2-3 weeks. Neither requires infrastructure management.

## Catalog and Data Model Flexibility

This is where the tools diverge sharply.

**Backstage** uses a YAML-based catalog with a fixed schema (Component, API, Resource, System, Domain, Group, User). You can add annotations but can't fundamentally change the model without forking:

```yaml
# catalog-info.yaml in your repo
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: payment-service
  annotations:
    github.com/project-slug: company/payment-service
    pagerduty.com/service-id: P123ABC
    backstage.io/techdocs-ref: dir:.
spec:
  type: service
  lifecycle: production
  owner: team-payments
  system: checkout
  dependsOn:
    - resource:payments-db
    - component:user-service
```

**Port** lets you define arbitrary blueprints. Want to model your infrastructure differently than your services? Create separate blueprints with relations. Need to track ML models, feature flags, or database migrations as first-class entities? Define them. This flexibility is Port's killer feature for complex organizations.

**Cortex** has a more fixed model but enriches it heavily with integrations. It automatically pulls data from 50+ tools (PagerDuty, Datadog, SonarQube, Snyk) and stitches it together. Less flexible schema, but faster time to comprehensive service views.

## Scorecards and Service Maturity

If driving engineering standards is your primary goal, Cortex leads here. Its scorecard engine is sophisticated:

- CQL (Cortex Query Language) for complex rules
- Tiered scoring with weighted categories
- Automatic data collection from integrated tools
- Initiative tracking with deadlines and ownership

Port added scorecards recently and they're capable but require more manual setup. You define rules against your custom data model, which is powerful but means you're building the integration layer.

Backstage has community plugins for scorecards (like the Spotify `soundcheck` plugin), but they're bolted-on rather than core functionality.

For organizations where "every service must have runbooks, 80% test coverage, and Datadog dashboards" is the goal, Cortex gets you there fastest.

## Self-Service Actions and Workflows

All three support self-service developer workflows, but implementation differs:

**Backstage Software Templates** are powerful but complex. You write templates in YAML with Nunjucks templating, define multi-step workflows, and can call arbitrary APIs. The learning curve is steep.

**Port Self-Service Actions** connect to your existing automation. Define a form in Port, trigger a GitHub Action, Jenkins job, or webhook. Port tracks execution status and logs. It's glue, not a workflow engine.

**Cortex Scaffolder** is newer and more limited but integrates tightly with their catalog. Good for "create a new service from template" workflows.

For mature platform teams with existing automation, Port's approach (orchestrate what you have) beats rebuilding in Backstage's template system.

## Cost Reality Check

Backstage is "free" but costs engineering time. Budget for:
- 0.5-1 FTE for ongoing maintenance
- Infrastructure: $500-2000/month depending on scale
- Plugin development: significant if you need custom integrations

Port and Cortex pricing is per-user, typically:
- Port: $20-40/user/month (varies by tier)
- Cortex: $25-50/user/month (varies by features)

At 200 engineers, you're looking at $48k-120k/year for commercial tools. Backstage's TCO at that scale, including engineering time, often exceeds this—but you own the codebase and have unlimited customization.

## The Decision Framework

Choose **Backstage** if:
- You have platform engineering capacity (2+ dedicated engineers)
- Your requirements are highly custom
- Vendor lock-in is a dealbreaker
- You're willing to invest 6+ months before seeing significant value

Choose **Port** if:
- Your organization has a complex domain model beyond standard microservices
- You need flexibility in how you represent your software ecosystem
- You have existing automation you want to orchestrate, not replace
- You value fast time-to-value over unlimited customization

Choose **Cortex** if:
- Driving service maturity and engineering standards is the primary goal
- You use tools Cortex integrates with natively (most major observability/security tools)
- You want opinionated best practices, not a blank canvas
- Scorecards and compliance tracking are top priorities

## What I'd Actually Do

For most organizations under 300 engineers without dedicated platform teams: start with Port or Cortex. Get value in weeks, not months. If you outgrow them or hit customization walls, you'll have learned what you actually need and can make an informed Backstage investment.

For larger organizations or those with existing platform engineering investment: evaluate Backstage seriously, but run a time-boxed pilot (8 weeks) with a clear definition of done. If you can't get a working catalog with your critical integrations in that window, the long-term maintenance burden will be worse than you expect.

Spin up trials of all three this week. Connect your GitHub org, import 10 services, and build one self-service workflow in each. The right choice becomes obvious when you're hands-on.