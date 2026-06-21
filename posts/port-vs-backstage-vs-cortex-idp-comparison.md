---
title: "Port vs Backstage vs Cortex: IDP Comparison for 2024"
date: 2026-06-21
excerpt: "Real-world comparison of Port, Backstage, and Cortex IDPs. Setup complexity, plugin ecosystems, and total cost breakdown from hands-on experience."
tags: ["internal-developer-platform","backstage","devops-tools","platform-engineering","developer-experience"]
author: GeekOnCloud
draft: false
---

The Internal Developer Platform (IDP) market has exploded, and if you're evaluating options in 2024, you've likely narrowed it down to three frontrunners: Port, Backstage, and Cortex. I've deployed all three in production environments ranging from 50 to 500+ engineers. Here's what actually matters when choosing between them.

## The Fundamental Architecture Split

Before comparing features, understand this: Backstage is open-source infrastructure you operate. Port and Cortex are SaaS platforms you consume. This isn't a minor detail—it dictates your entire adoption journey.

Backstage gives you a React/Node.js application with a plugin architecture. You fork it, customize it, host it, and maintain it. Spotify open-sourced it in 2020, and the CNCF now stewards it. Your team owns the deployment:

```bash
# Backstage local setup
npx @backstage/create-app@latest
cd my-backstage-app

# You'll need a PostgreSQL database
docker run -d \
  --name backstage-db \
  -e POSTGRES_PASSWORD=backstage \
  -e POSTGRES_USER=backstage \
  -e POSTGRES_DB=backstage \
  -p 5432:5432 \
  postgres:14

# Start development server
yarn dev
```

Port and Cortex? You sign up, get an API key, and start pushing data. No infrastructure to manage. The tradeoff is obvious: control versus operational burden.

## Catalog and Service Definition

All three tools center on a service catalog, but implementation differs significantly.

Backstage uses `catalog-info.yaml` files living in each repository:

```yaml
# catalog-info.yaml in your service repo
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: payment-service
  description: Handles payment processing
  annotations:
    github.com/project-slug: myorg/payment-service
    pagerduty.com/service-id: P2E8XYZ
    backstage.io/techdocs-ref: dir:.
  tags:
    - python
    - payments
    - tier-1
spec:
  type: service
  lifecycle: production
  owner: team-payments
  system: checkout
  dependsOn:
    - component:user-service
    - resource:payments-database
  providesApis:
    - payment-api
```

Port takes a different approach with "blueprints"—you define entity schemas in their UI or via API, then populate them through integrations or direct API calls. This gives you flexibility but requires upfront schema design.

Cortex auto-discovers services by connecting to your cloud providers, Kubernetes clusters, and git hosts. It then enriches that data through integrations. Less configuration upfront, but you're working within their data model.

In practice: Backstage's file-based approach scales well with GitOps workflows. Engineers update their own `catalog-info.yaml` in PRs. Port's flexibility shines when your service definitions don't fit standard patterns. Cortex's discovery model works best when you want fast time-to-value without changing existing workflows.

## Scorecards and Engineering Standards

This is where Cortex genuinely excels. Their scorecard system is mature, opinionated, and production-tested:

- Define rules like "service must have runbook," "container image under 500MB," "test coverage above 80%"
- Services get graded automatically
- Track improvement over time with historical data
- CQL (Cortex Query Language) for complex queries

Port added scorecards later, and they're capable but less refined. You define rules in their UI and can get creative with custom conditions.

Backstage requires the TechInsights plugin for similar functionality. It works, but you're assembling it yourself:

```yaml
# tech-insights configuration example
techInsights:
  factRetrievers:
    - id: hasReadme
      name: Has README
      description: Checks if repository has a README file
      schedule:
        frequency: { hours: 6 }
        timeout: { minutes: 10 }
    - id: hasOwner
      name: Has Owner
      description: Checks if catalog entry has owner defined
```

The Backstage approach requires more setup but lets you define checks against any data source you can query. I've seen teams build checks against internal compliance databases that neither Port nor Cortex could touch.

**Real numbers from my deployments:**
- Cortex scorecards: 2-hour setup for basic standards, production-ready day one
- Port scorecards: 4-6 hours for equivalent coverage
- Backstage TechInsights: 2-3 days minimum, often a week with custom fact retrievers

## Self-Service Actions and Workflows

This is Port's differentiator. Their "self-service actions" system is the most powerful of the three. You define forms in the UI, wire them to backends (GitHub Actions, webhooks, Kubernetes jobs), and developers get one-click provisioning:

```yaml
# Port action definition (simplified)
identifier: create-microservice
title: Create New Microservice
trigger: CREATE
userInputs:
  properties:
    service_name:
      type: string
      pattern: "^[a-z][a-z0-9-]*$"
    language:
      type: string
      enum: ["python", "go", "node"]
    team:
      type: string
      format: team
invocationMethod:
  type: GITHUB
  org: myorg
  repo: platform-actions
  workflow: create-service.yaml
```

Backstage has Software Templates, which are powerful but require more engineering. You write templates in YAML with Nunjucks/Jinja2 templating, and the scaffolder plugin executes them. The template catalog lives in your Backstage instance.

Cortex's scaffolding feature launched more recently and focuses on Cookiecutter-style templates. Functional, but not as flexible as Port or Backstage for complex multi-step workflows.

If self-service provisioning is your primary use case, Port wins on time-to-value. Backstage wins on flexibility. Cortex is best when you primarily need catalog and scorecards with light provisioning needs.

## Integration Depth and Ecosystem

Backstage's plugin ecosystem is massive—600+ plugins covering everything from Kubernetes to Snyk to LaunchDarkly. But quality varies wildly. Some plugins are production-grade; others are abandoned prototypes. You'll likely write or fork plugins.

Port and Cortex have curated integrations. Fewer total, but they work reliably out of the box. Both cover the essentials: GitHub/GitLab, PagerDuty, Datadog, Kubernetes, AWS, Snyk, SonarQube.

The key difference: when an integration doesn't exist in Backstage, you build a plugin (significant effort). In Port, you use their generic REST API integration or webhook triggers. In Cortex, you can push custom data via their API, but you're working within their entity model.

## Cost Reality

Backstage is free but not cheap. Running it properly requires:
- 1-2 engineers maintaining it (not full-time, but meaningful allocation)
- Infrastructure costs (compute, database, CDN)
- Plugin development and maintenance

For a 200-person engineering org, budget $50-100k/year in total cost of ownership.

Port and Cortex pricing isn't public, but expect:
- Port: typically $30-50 per developer/month
- Cortex: similar range, often $40-60 per developer/month

At 200 developers, you're looking at $72k-144k/year for SaaS options. The math often favors SaaS unless you have specific customization needs that only Backstage can address.

## Making the Decision

Choose **Backstage** if:
- You have platform engineering capacity (2+ dedicated engineers)
- You need deep customization or proprietary integrations
- You want to avoid vendor lock-in at all costs
- Your organization already runs significant internal tooling

Choose **Port** if:
- Self-service actions and developer workflows are the priority
- You want flexibility in data modeling
- Your team is lean and can't maintain open-source infrastructure
- You're comfortable with a newer vendor (founded 2021)

Choose **Cortex** if:
- Engineering standards and scorecards are the primary driver
- You want fast time-to-value with minimal configuration
- Service catalog is the main use case, not complex workflows
- You value a mature product with established customers

Start with a 30-day proof-of-concept using your actual services. Onboard one team, measure adoption friction, and evaluate whether the tool improves developer experience or adds another dashboard to ignore. The best IDP is the one your engineers actually use.