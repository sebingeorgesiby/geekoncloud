---
title: "Building an Internal Developer Platform with Backstage"
date: 2026-10-13
excerpt: "Deploy Backstage IDP from scratch: service catalog, templates, TechDocs, and plugins. Real configs for platform engineering teams."
tags: ["backstage","internal-developer-platform","platform-engineering","developer-experience","kubernetes"]
author: GeekOnCloud
draft: false
---

Every platform team eventually faces the same crisis: developers spending 40% of their time not writing code, but navigating a maze of internal tools, documentation wikis, and Slack channels asking "who owns this service?" Backstage, Spotify's open-source developer portal, emerged from exactly this pain. After rolling it out across three organizations, I can tell you it's not a magic bullet—but when implemented correctly, it becomes the single pane of glass that actually sticks.

## Why Backstage Wins Where Others Failed

The graveyard of internal developer portals is vast. Most fail because they try to replace existing tools rather than unify them. Backstage takes the opposite approach: it's a plugin-based framework that aggregates your existing infrastructure into a coherent experience. Your CI/CD stays in GitHub Actions. Your monitoring stays in Datadog. Your docs stay in Markdown. Backstage just makes them discoverable.

The architecture is deceptively simple: a React frontend, a Node.js backend, and a PostgreSQL database for the software catalog. Everything else—Kubernetes integration, CI/CD visibility, documentation rendering—comes through plugins. Spotify ships around 100 official plugins, but the real power is writing your own.

What makes this work in practice is the software catalog. Every service, library, API, and resource gets a `catalog-info.yaml` that lives in its repo. This creates a single source of truth that's version-controlled, owned by the teams who build the software, and automatically stays up to date.

## Standing Up Your First Instance

Skip the Docker Compose setup for anything beyond local testing. For a real deployment, you want Kubernetes from day one. Here's a battle-tested approach using Helm:

```bash
# Create namespace and install PostgreSQL first
kubectl create namespace backstage
helm repo add bitnami https://charts.bitnami.com/bitnami
helm install backstage-db bitnami/postgresql \
  --namespace backstage \
  --set auth.postgresPassword=<generate-secure-password> \
  --set auth.database=backstage \
  --set primary.persistence.size=20Gi

# Install Backstage using the official Helm chart
helm repo add backstage https://backstage.github.io/charts
helm install backstage backstage/backstage \
  --namespace backstage \
  --set backstage.image.registry=your-registry.io \
  --set backstage.image.repository=backstage \
  --set backstage.image.tag=1.23.0 \
  --set postgresql.enabled=false \
  --set backstage.extraEnvVars[0].name=POSTGRES_HOST \
  --set backstage.extraEnvVars[0].value=backstage-db-postgresql \
  --set backstage.extraEnvVars[1].name=POSTGRES_PORT \
  --set backstage.extraEnvVars[1].value="5432"
```

The critical piece most tutorials skip: you need to build a custom Docker image that includes your plugins and configuration. The base Backstage image is just a skeleton. Create a `packages/backend/Dockerfile` in your Backstage app directory and run `yarn build:backend` before pushing to your registry.

For authentication, don't roll your own. Use the GitHub Auth provider if your org is GitHub-centric, or the Okta/Auth0 plugins for enterprise SSO. The `app-config.yaml` configuration looks like this:

```yaml
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
            - resolver: emailMatchingUserEntityProfileEmail

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

The `github-discovery` location type is gold—it automatically scans all repos in your org for `catalog-info.yaml` files. No manual registration required.

## The Software Catalog: Getting It Right

The catalog is the heart of Backstage, and its effectiveness depends entirely on the quality of your `catalog-info.yaml` files. Here's a template that captures what actually matters:

```yaml
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: payment-service
  description: Handles all payment processing and Stripe integration
  annotations:
    github.com/project-slug: your-org/payment-service
    backstage.io/techdocs-ref: dir:.
    pagerduty.com/integration-key: ${PAGERDUTY_KEY}
    datadoghq.com/dashboard-url: https://app.datadoghq.com/dashboard/abc-123
    argocd/app-name: payment-service-prod
  tags:
    - python
    - payments
    - critical
  links:
    - url: https://runbooks.internal/payment-service
      title: Runbooks
      icon: docs
spec:
  type: service
  lifecycle: production
  owner: group:payments-team
  system: checkout-system
  dependsOn:
    - resource:payments-database
    - component:notification-service
  providesApis:
    - payment-api
```

The `owner` field references entities in your org catalog. Populate this by syncing from GitHub Teams or your identity provider. The `dependsOn` and `providesApis` fields create the service graph that makes Backstage actually useful for incident response—you can immediately see what's affected when something breaks.

## Software Templates: Your Golden Paths

Templates transform Backstage from a catalog into a developer platform. They encode your organization's best practices into repeatable workflows. A developer clicks "Create," fills out a form, and gets a production-ready service with CI/CD, monitoring, and deployment pipelines already configured.

Create templates in `templates/` directories and register them in your catalog. The `template.yaml` uses a steps-based approach:

```yaml
apiVersion: scaffolder.backstage.io/v1beta3
kind: Template
metadata:
  name: python-service
  title: Python Microservice
  description: Creates a Python FastAPI service with all platform integrations
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
          title: Owner Team
          type: string
          ui:field: OwnerPicker
          ui:options:
            catalogFilter:
              kind: Group
  steps:
    - id: fetch-base
      name: Fetch Base Template
      action: fetch:template
      input:
        url: ./skeleton
        values:
          name: ${{ parameters.name }}
          owner: ${{ parameters.owner }}
    - id: create-repo
      name: Create GitHub Repository
      action: publish:github
      input:
        repoUrl: github.com?owner=your-org&repo=${{ parameters.name }}
        defaultBranch: main
        protectDefaultBranch: true
    - id: create-argocd-app
      name: Register with ArgoCD
      action: argocd:create-resources
      input:
        appName: ${{ parameters.name }}
        projectName: default
        repoUrl: https://github.com/your-org/${{ parameters.name }}
    - id: register
      name: Register in Catalog
      action: catalog:register
      input:
        repoContentsUrl: ${{ steps['create-repo'].output.repoContentsUrl }}
        catalogInfoPath: /catalog-info.yaml
```

The skeleton directory contains your templated files—Dockerfile, GitHub Actions workflows, Terraform modules, whatever your golden path includes. Use Nunjucks templating syntax (`${{ values.name }}`) for variable substitution.

## TechDocs: Documentation That Doesn't Rot

Backstage's TechDocs plugin renders Markdown documentation directly in the portal, pulled from each service's repository. The secret to making this work: treat docs as code with the same review process.

Configure TechDocs to use the "recommended" deployment (external storage) rather than local for production:

```yaml
techdocs:
  builder: external
  generator:
    runIn: local
  publisher:
    type: awsS3
    awsS3:
      bucketName: your-techdocs-bucket
      region: us-east-1
      credentials:
        roleArn: arn:aws:iam::123456789:role/techdocs-publisher
```

Add a GitHub Action to your service repos that runs `techdocs-cli generate && techdocs-cli publish` on every docs change. Now documentation updates flow through PRs, get reviewed, and auto-publish. No more wiki rot.

## Making Adoption Stick

The technical implementation is the easy part. Adoption is where internal platforms die. Three things that worked for us:

First, make the software catalog mandatory for production deployment. Your ArgoCD or Flux config should require a valid `catalog-info.yaml` with an owner specified. No catalog entry, no deployment.

Second, instrument everything. Track how often developers use templates versus creating repos manually. Measure time-to-first-deploy for new services. When you can show that template-created services deploy in 15 minutes versus 2 days for manual setup, adoption arguments make themselves.

Third, build a plugin for something developers desperately need but currently can't find—your internal package registry, your secrets management, your cost attribution dashboard. That one integration becomes the reason they log into Backstage daily.

Start with five services from two different teams in your catalog. Get those teams to create one template together. Expand from there. The platform that works is the one that grows organically from actual developer pain, not the one mandated from above.