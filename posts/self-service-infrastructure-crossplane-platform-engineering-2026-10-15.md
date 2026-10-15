---
title: "Self-Service Infrastructure with Crossplane: Platform Engineering"
date: 2026-10-15
excerpt: "Build internal developer platforms with Crossplane. Real XRDs, compositions, and GitOps patterns for self-service AWS/GCP infrastructure provisioning."
tags: ["crossplane","platform-engineering","kubernetes","gitops","infrastructure-as-code"]
author: GeekOnCloud
draft: false
---

Your developers are stuck in a ticket queue. They need a database for the new feature, a Redis cache for session management, a storage bucket for user uploads. Each request sits in a backlog while platform engineers context-switch between Terraform PRs, Jira tickets, and Slack threads. Meanwhile, AWS costs spiral because nobody has time to right-size anything.

Crossplane flips this model. Instead of developers requesting infrastructure through tickets, they declare what they need using Kubernetes-native APIs. The platform team defines the guardrails once, and developers self-serve within those boundaries. No more bottlenecks. No more shadow IT. No more "just spin up an EC2 instance with my personal AWS credentials."

## What Crossplane Actually Does

Crossplane extends Kubernetes with Custom Resource Definitions (CRDs) that represent cloud infrastructure. When you apply a YAML manifest describing an RDS instance, Crossplane's controllers reconcile that desired state against AWS, GCP, or Azure—same control loop that makes Kubernetes deployments self-healing.

The key innovation is **Compositions**. These are templates that abstract cloud-specific details behind a simplified API. A developer requests a "Database" with size "small" and environment "staging." The Composition translates that into an RDS instance with the right instance class, subnet group, security groups, parameter groups, and backup configuration for your organization's staging environment.

Three layers make this work:
1. **Providers** — Controllers that talk to cloud APIs (AWS, GCP, Azure, Terraform, Helm)
2. **Managed Resources** — Direct representations of cloud resources (like an `RDSInstance`)
3. **Composite Resources (XRs)** — Your abstracted APIs that map to one or more managed resources via Compositions

## Building Your First Composition

Let's build a real example: a self-service PostgreSQL database. Developers specify database name, size tier, and whether they need read replicas. Platform team controls VPC placement, encryption, backup policies.

First, define the Composite Resource Definition (XRD)—the API contract:

```yaml
apiVersion: apiextensions.crossplane.io/v1
kind: CompositeResourceDefinition
metadata:
  name: xpostgresdatabases.database.geekoncloud.com
spec:
  group: database.geekoncloud.com
  names:
    kind: XPostgresDatabase
    plural: xpostgresdatabases
  claimNames:
    kind: PostgresDatabase
    plural: postgresdatabases
  versions:
    - name: v1alpha1
      served: true
      referenceable: true
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              properties:
                parameters:
                  type: object
                  properties:
                    size:
                      type: string
                      enum: ["small", "medium", "large"]
                      description: "small=db.t3.micro, medium=db.t3.small, large=db.t3.medium"
                    environment:
                      type: string
                      enum: ["dev", "staging", "prod"]
                    enableReadReplica:
                      type: boolean
                      default: false
                  required:
                    - size
                    - environment
```

Now the Composition that implements it:

```yaml
apiVersion: apiextensions.crossplane.io/v1
kind: Composition
metadata:
  name: postgres-aws
  labels:
    provider: aws
spec:
  compositeTypeRef:
    apiVersion: database.geekoncloud.com/v1alpha1
    kind: XPostgresDatabase
  patchSets:
    - name: common-tags
      patches:
        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.environment
          toFieldPath: spec.forProvider.tags[0].value
  resources:
    - name: rds-instance
      base:
        apiVersion: rds.aws.crossplane.io/v1beta1
        kind: Instance
        spec:
          forProvider:
            region: us-east-1
            dbInstanceClass: db.t3.micro
            engine: postgres
            engineVersion: "15.4"
            masterUsername: admin
            allocatedStorage: 20
            publiclyAccessible: false
            storageEncrypted: true
            storageType: gp3
            dbSubnetGroupName: main-subnet-group
            vpcSecurityGroupIds:
              - sg-0abc123def456789
            tags:
              - key: Environment
                value: ""
              - key: ManagedBy
                value: crossplane
          providerConfigRef:
            name: aws-provider
      patches:
        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.size
          toFieldPath: spec.forProvider.dbInstanceClass
          transforms:
            - type: map
              map:
                small: db.t3.micro
                medium: db.t3.small
                large: db.t3.medium
        - patchSetName: common-tags
        - type: ToCompositeFieldPath
          fromFieldPath: status.atProvider.endpoint.address
          toFieldPath: status.endpoint
```

Developers now request a database with a simple claim:

```yaml
apiVersion: database.geekoncloud.com/v1alpha1
kind: PostgresDatabase
metadata:
  name: orders-service-db
  namespace: orders-team
spec:
  parameters:
    size: medium
    environment: staging
    enableReadReplica: false
```

Apply it, and Crossplane provisions the RDS instance with all your organization's standards baked in.

## The RBAC Layer That Makes It Safe

Self-service without guardrails is chaos. Crossplane's power comes from combining Kubernetes RBAC with your Compositions.

Create a ClusterRole that only allows developers to create claims, not raw managed resources:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: database-consumer
rules:
  - apiGroups: ["database.geekoncloud.com"]
    resources: ["postgresdatabases"]
    verbs: ["get", "list", "watch", "create", "update", "delete"]
```

Bind this to your developer groups. They can create `PostgresDatabase` claims in their namespace, but they can't create `RDSInstance` managed resources directly. They can't request a `db.r6g.16xlarge` because your Composition only maps small/medium/large to approved instance types. They can't put databases in public subnets because your Composition hardcodes `publiclyAccessible: false`.

For cost control, combine this with namespace quotas:

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: database-quota
  namespace: orders-team
spec:
  hard:
    count/postgresdatabases.database.geekoncloud.com: "3"
```

Three databases per team. Need more? That's a conversation, not a blocked ticket.

## Production Patterns That Actually Work

**Secret injection** — Crossplane writes connection strings to Kubernetes Secrets. Use the `writeConnectionSecretToRef` field in your claim, then mount that secret in your application pods. No manual secret copying.

**Environment promotion** — Same claim manifest deploys to dev, staging, prod. The Composition uses `spec.parameters.environment` to select different instance sizes, backup retention periods, and Multi-AZ configurations. Dev gets a `db.t3.micro` with no backups. Prod gets `db.r6g.large` with Multi-AZ and 30-day retention.

**Composition functions** — When patches aren't enough, write composition functions in Go, Python, or KCL. Need to generate a random suffix for globally-unique bucket names? Fetch secrets from Vault for the master password? Validate that production databases require read replicas? Functions handle it.

**Drift detection** — Crossplane continuously reconciles. If someone modifies the RDS instance through the AWS console, Crossplane reverts it. This sounds annoying until you realize it's exactly how you prevent configuration drift in production.

**Cost attribution** — Tag everything through your Compositions. The `ManagedBy: crossplane` tag plus `Team: ${claim.namespace}` gives you per-team cloud cost breakdowns without chasing developers for tagging compliance.

## The Migration Path

You probably have existing Terraform. Don't rewrite it.

Crossplane's Terraform provider lets you wrap existing modules:

```yaml
apiVersion: tf.crossplane.io/v1beta1
kind: Workspace
metadata:
  name: existing-vpc
spec:
  forProvider:
    module: git::https://github.com/yourorg/terraform-modules.git//vpc?ref=v2.3.1
    vars:
      - key: environment
        value: staging
```

This isn't the long-term goal—native providers are more efficient—but it lets you adopt Crossplane incrementally. New infrastructure goes through Compositions. Existing Terraform modules get wrapped as Workspaces. Over time, migrate the high-churn resources (databases, caches, queues) to native providers where the reconciliation loop adds real value.

## Getting Started Tomorrow

Install Crossplane on any Kubernetes cluster:

```bash
helm repo add crossplane-stable https://charts.crossplane.io/stable
helm install crossplane crossplane-stable/crossplane \
  --namespace crossplane-system \
  --create-namespace

# Install AWS provider
kubectl apply -f - <<EOF
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-aws
spec:
  package: xpkg.upbound.io/upbound/provider-family-aws:v1.1.0
EOF
```

Start with one Composition for your most-requested resource. Databases are a good choice—frequently requested, expensive to misconfigure, obvious value from standardization. Get one team using it in dev. Iterate on the API based on their feedback. Then expand.

The ticket queue won't empty itself. Build the platform that makes tickets unnecessary.