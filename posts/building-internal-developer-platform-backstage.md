---
title: "Building an Internal Developer Platform with Backstage"
date: 2026-06-13
excerpt: "Deploy Backstage IDP from scratch: service catalog, software templates, TechDocs, and plugin development. Real configs and production patterns included."
tags: ["backstage","internal-developer-platform","platform-engineering","developer-experience","kubernetes"]
author: GeekOnCloud
draft: false
---

Every platform team I've worked with has the same problem: developers spend 20% of their time actually writing code and 80% hunting through Confluence pages, Slack channels, and tribal knowledge to figure out who owns what service, where the docs live, and how to deploy their changes. Backstage—Spotify's open-source developer portal—fixes this by creating a single pane of glass for your entire software ecosystem. After rolling it out across three organizations, here's exactly how to build an internal developer platform that developers will actually use.

## Why Backstage Over Building Your Own Portal

I've seen teams burn six months building custom developer portals that become unmaintained nightmares within a year. Backstage gives you a plugin architecture, a service catalog, and TechDocs out of the box. The real value isn't the UI—it's the software catalog that creates a standardized way to describe every service, library, and resource in your organization.

The core concept is the **catalog-info.yaml** file that lives in every repo. This isn't just metadata—it's the contract that connects your code to ownership, documentation, CI/CD pipelines, and infrastructure. When a new engineer joins, they don't ask "who owns the payment service?"—they search the catalog.

Backstage runs as a Node.js application with a PostgreSQL backend. In production, you're looking at about 512MB-1GB RAM for a small org (under 500 services), scaling to 2-4GB for larger deployments with heavy plugin usage.

## Setting Up Backstage from Scratch

Skip the `npx @backstage/create-app` if you're going to production—you'll want more control. Here's how I set up Backstage with proper configuration:

```bash
# Clone and set up the app
npx @backstage/create-app@latest --skip-install
cd my-backstage-app

# Use yarn 3 with node-modules linker (avoids PnP headaches)
corepack enable
yarn set version 3.6.4
echo 'nodeLinker: node-modules' >> .yarnrc.yml
yarn install

# Set up PostgreSQL instead of SQLite
docker run -d \
  --name backstage-postgres \
  -e POSTGRES_USER=backstage \
  -e POSTGRES_PASSWORD=backstage \
  -e POSTGRES_DB=backstage \
  -p 5432:5432 \
  postgres:15-alpine
```

Now wire up the database and authentication in `app-config.yaml`:

```yaml
app:
  title: Acme Developer Portal
  baseUrl: http://localhost:3000

backend:
  baseUrl: http://localhost:7007
  database:
    client: pg
    connection:
      host: ${POSTGRES_HOST}
      port: ${POSTGRES_PORT}
      user: ${POSTGRES_USER}
      password: ${POSTGRES_PASSWORD}
      database: backstage
  cors:
    origin: http://localhost:3000
    methods: [GET, HEAD, PATCH, POST, PUT, DELETE]
    credentials: true

auth:
  environment: production
  providers:
    github:
      production:
        clientId: ${GITHUB_CLIENT_ID}
        clientSecret: ${GITHUB_CLIENT_SECRET}
        signIn:
          resolvers:
            - resolver: usernameMatchingUserEntityName

catalog:
  import:
    entityFilename: catalog-info.yaml
    pullRequestBranchName: backstage-integration
  rules:
    - allow: [Component, System, API, Resource, Location, Template, Group, User]
  locations:
    - type: url
      target: https://github.com/your-org/service-catalog/blob/main/all-services.yaml
    - type: github-discovery
      target: https://github.com/your-org
```

That `github-discovery` location is crucial—it automatically finds `catalog-info.yaml` files across all your repos instead of manually registering each one.

## Designing Your Entity Model

This is where most teams screw up. They either over-engineer the metadata schema or leave it so sparse it's useless. Here's a battle-tested `catalog-info.yaml` structure that balances completeness with maintainability:

```yaml
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: payment-service
  title: Payment Processing Service
  description: Handles all payment transactions, refunds, and billing integration
  annotations:
    github.com/project-slug: your-org/payment-service
    backstage.io/techdocs-ref: dir:.
    pagerduty.com/service-id: PXXXXXX
    argocd/app-name: payment-service-prod
    sonarqube.org/project-key: payment-service
    jenkins.io/job-full-name: payment-service/main
  tags:
    - python
    - critical
    - pci-compliant
  links:
    - url: https://grafana.internal/d/payment-service
      title: Grafana Dashboard
      icon: dashboard
    - url: https://runbooks.internal/payment-service
      title: Runbooks
      icon: docs
spec:
  type: service
  lifecycle: production
  owner: group:payments-team
  system: billing-platform
  dependsOn:
    - component:user-service
    - resource:payments-database
  providesApis:
    - payment-api
  consumesApis:
    - stripe-webhook-api
---
apiVersion: backstage.io/v1alpha1
kind: API
metadata:
  name: payment-api
  description: REST API for payment operations
spec:
  type: openapi
  lifecycle: production
  owner: group:payments-team
  definition:
    $text: ./openapi.yaml
```

The annotations are where the magic happens. Each one connects to a Backstage plugin: `pagerduty.com/service-id` shows on-call schedules, `argocd/app-name` displays deployment status, `sonarqube.org/project-key` surfaces code quality metrics. One YAML file, unified view.

## Essential Plugins for Day One

Don't install twenty plugins hoping something sticks. Start with these five that solve immediate pain:

**GitHub Integration** (built-in): Pull requests, actions status, and code owners displayed directly in the catalog. Zero config beyond the GitHub auth you already set up.

**TechDocs**: Render Markdown docs from your repos into Backstage. Engineers write docs where they live (in the repo), and they're automatically published. Add this to your `catalog-info.yaml`:

```yaml
annotations:
  backstage.io/techdocs-ref: dir:.
```

Then drop a `mkdocs.yml` in your repo root and a `docs/` folder. Done.

**Kubernetes Plugin**: Shows pod status, deployments, and logs for services. Requires a service account with read access to your clusters. After setup, developers see real-time deployment status without kubectl access.

**Software Templates**: This is the killer feature. Define golden paths for creating new services:

```yaml
apiVersion: scaffolder.backstage.io/v1beta3
kind: Template
metadata:
  name: python-service
  title: Python Microservice
  description: Create a production-ready Python service with CI/CD
spec:
  owner: platform-team
  type: service
  parameters:
    - title: Service Details
      required:
        - name
        - owner
      properties:
        name:
          title: Service Name
          type: string
          pattern: '^[a-z0-9-]+$'
        owner:
          title: Owner
          type: string
          ui:field: OwnerPicker
          ui:options:
            catalogFilter:
              kind: Group
  steps:
    - id: fetch
      name: Fetch Template
      action: fetch:template
      input:
        url: ./skeleton
        values:
          name: ${{ parameters.name }}
          owner: ${{ parameters.owner }}
    - id: publish
      name: Create Repository
      action: publish:github
      input:
        repoUrl: github.com?owner=your-org&repo=${{ parameters.name }}
        description: ${{ parameters.name }} service
    - id: register
      name: Register in Catalog
      action: catalog:register
      input:
        repoContentsUrl: ${{ steps.publish.output.repoContentsUrl }}
        catalogInfoPath: /catalog-info.yaml
```

New service, GitHub repo, CI/CD pipeline, registered in the catalog—all from a web form. This is how you enforce standards without becoming a bottleneck.

## Production Deployment Patterns

Run Backstage on Kubernetes with a proper Helm chart. The community chart at `backstage/charts` works, but I prefer building a custom one for more control over resource limits and health checks:

```yaml
# values.yaml for Backstage Helm deployment
backstage:
  replicas: 2
  resources:
    requests:
      memory: 1Gi
      cpu: 500m
    limits:
      memory: 2Gi
      cpu: 1000m
  
  extraEnvVars:
    - name: POSTGRES_HOST
      valueFrom:
        secretKeyRef:
          name: backstage-db
          key: host
    - name: GITHUB_CLIENT_ID
      valueFrom:
        secretKeyRef:
          name: backstage-auth
          key: github-client-id

postgresql:
  enabled: false  # Use external RDS/Cloud SQL instead

ingress:
  enabled: true
  host: backstage.internal.company.com
  annotations:
    kubernetes.io/ingress.class: nginx
    cert-manager.io/cluster-issuer: letsencrypt-prod
```

For high availability: run 2+ replicas behind a load balancer, use an external PostgreSQL instance (RDS, Cloud SQL), and put TechDocs assets in S3/GCS with the `techdocs.publisher.type: awsS3` configuration.

## Driving Adoption Without Mandates

The fastest way to kill a developer portal is to mandate its use. Instead, make it the path of least resistance. Integrate Backstage links into your existing workflows: Slack bot that searches the catalog, GitHub Actions that fail if `catalog-info.yaml` is missing, PagerDuty incidents that link directly to the service's Backstage page.

Track adoption with these metrics: catalog coverage (percentage of repos with `catalog-info.yaml`), weekly active users, and template usage. At one org, we hit 90% catalog coverage in three months by making template-created services the default path for new projects—it was simply faster than doing it manually.

Start by cataloging your ten most critical services this week. Add the GitHub and Kubernetes plugins. Create one software template for your most common service type. That's your MVP—ship it, get feedback, iterate. The platform that exists beats the perfect platform that never launches.