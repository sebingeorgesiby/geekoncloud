---
title: "Self-Service Infrastructure with Crossplane: Platform Engineering"
date: 2026-09-16
excerpt: "Build internal developer platforms with Crossplane. Real XRDs, compositions, and RBAC configs for self-service AWS/GCP infrastructure provisioning."
tags: ["crossplane","platform-engineering","kubernetes","infrastructure-as-code","self-service"]
author: GeekOnCloud
draft: false
---

Infrastructure provisioning is still a bottleneck in most organizations. Developers file tickets, wait for platform teams, and context-switch while someone manually clicks through cloud consoles or runs Terraform from their laptop. Crossplane flips this model: developers request infrastructure through Kubernetes-native APIs, and the platform team defines the guardrails once. Here's how to build a self-service infrastructure platform that actually works.

## Why Kubernetes as the Control Plane

Crossplane extends Kubernetes to manage any infrastructure—AWS, GCP, Azure, or your own APIs. This isn't about running your databases in Kubernetes. It's about using Kubernetes as a universal control plane.

The key insight: Kubernetes already solved resource management, reconciliation loops, RBAC, and declarative state. Crossplane leverages all of this for cloud resources. Your developers already know `kubectl`. Now they can provision RDS databases the same way they deploy pods.

The real power comes from Composite Resources (XRs). You define an abstraction—say, a `Database`—and Crossplane composes the underlying resources: RDS instance, security group, subnet group, parameter group, IAM role. Developers see one resource. You control what's underneath.

## Installing Crossplane and AWS Provider

Start with a running Kubernetes cluster. Kind works for testing, but EKS or GKE for production:

```bash
# Install Crossplane with Helm
helm repo add crossplane-stable https://charts.crossplane.io/stable
helm repo update

helm install crossplane \
  --namespace crossplane-system \
  --create-namespace \
  crossplane-stable/crossplane \
  --version 1.14.5

# Wait for pods
kubectl get pods -n crossplane-system -w

# Install AWS provider
cat <<EOF | kubectl apply -f -
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-aws-s3
spec:
  package: xpkg.upbound.io/upbound/provider-aws-s3:v1.1.0
EOF

# For a full AWS deployment, you'll want multiple family providers:
# provider-aws-ec2, provider-aws-rds, provider-aws-iam, etc.
```

Now configure credentials. Never use long-lived keys in production—use IRSA (IAM Roles for Service Accounts):

```bash
# Create ProviderConfig with IRSA
cat <<EOF | kubectl apply -f -
apiVersion: aws.upbound.io/v1beta1
kind: ProviderConfig
metadata:
  name: default
spec:
  credentials:
    source: IRSA
EOF
```

Your EKS node role needs the appropriate IAM policies. Scope these tightly—Crossplane should only have permissions for resources you actually want it to manage.

## Building Your First Composite Resource

Here's where self-service happens. You'll create a Composite Resource Definition (XRD) that defines the API your developers see, and a Composition that defines what actually gets created.

Let's build a `PostgresInstance` abstraction that creates an RDS instance with sensible defaults:

```yaml
# xrd.yaml - The API your developers will use
apiVersion: apiextensions.crossplane.io/v1
kind: CompositeResourceDefinition
metadata:
  name: xpostgresinstances.database.geekoncloud.com
spec:
  group: database.geekoncloud.com
  names:
    kind: XPostgresInstance
    plural: xpostgresinstances
  claimNames:
    kind: PostgresInstance
    plural: postgresinstances
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
                      default: "small"
                    version:
                      type: string
                      default: "15.4"
                  required:
                    - size
              required:
                - parameters
            status:
              type: object
              properties:
                endpoint:
                  type: string
                port:
                  type: integer
```

Now the Composition—this is where platform engineering happens:

```yaml
# composition.yaml
apiVersion: apiextensions.crossplane.io/v1
kind: Composition
metadata:
  name: postgres-aws
  labels:
    provider: aws
spec:
  compositeTypeRef:
    apiVersion: database.geekoncloud.com/v1alpha1
    kind: XPostgresInstance
  resources:
    - name: rds-instance
      base:
        apiVersion: rds.aws.upbound.io/v1beta1
        kind: Instance
        spec:
          forProvider:
            engine: postgres
            allocatedStorage: 20
            maxAllocatedStorage: 100
            storageType: gp3
            storageEncrypted: true
            publiclyAccessible: false
            skipFinalSnapshot: false
            deletionProtection: true
            autoMinorVersionUpgrade: true
            backupRetentionPeriod: 7
            multiAz: false
            dbSubnetGroupNameSelector:
              matchControllerRef: true
            vpcSecurityGroupIdSelector:
              matchControllerRef: true
          providerConfigRef:
            name: default
      patches:
        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.version
          toFieldPath: spec.forProvider.engineVersion
        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.size
          toFieldPath: spec.forProvider.instanceClass
          transforms:
            - type: map
              map:
                small: db.t3.micro
                medium: db.t3.medium
                large: db.r6g.large
        - type: ToCompositeFieldPath
          fromFieldPath: status.atProvider.endpoint
          toFieldPath: status.endpoint
        - type: ToCompositeFieldPath
          fromFieldPath: status.atProvider.port
          toFieldPath: status.port
    # Add subnet group, security group resources here...
```

## The Developer Experience

With the XRD and Composition deployed, developers create databases like this:

```yaml
# my-database.yaml
apiVersion: database.geekoncloud.com/v1alpha1
kind: PostgresInstance
metadata:
  name: orders-db
  namespace: orders-team
spec:
  parameters:
    size: medium
    version: "15.4"
```

Apply it: `kubectl apply -f my-database.yaml`

That's it. No tickets. No waiting. The database provisions in 5-10 minutes. Status flows back through the Kubernetes API:

```bash
kubectl get postgresinstance orders-db -o yaml
# status:
#   endpoint: orders-db-xxxxx.us-east-1.rds.amazonaws.com
#   port: 5432
```

The connection details can feed directly into Secrets using Crossplane's connection secret mechanism, which developers can mount into their pods.

## Guardrails That Actually Guard

Self-service without guardrails is chaos. Crossplane gives you multiple enforcement points:

**Composition-level controls**: Developers can't choose arbitrary instance types. They pick `small`, `medium`, or `large`. You control the mapping. They can't disable encryption—it's hardcoded in the Composition.

**RBAC**: Standard Kubernetes RBAC applies. Namespace the Claims. Give the `orders-team` namespace permission to create `PostgresInstance` but not raw `Instance` resources.

**Usage limits**: Crossplane 1.14+ supports Usage resources that prevent deletion of resources still in use. Combined with Kyverno or Gatekeeper policies, you can enforce:

```yaml
# Gatekeeper constraint: max 3 databases per namespace
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sMaxDatabasesPerNamespace
metadata:
  name: max-databases
spec:
  match:
    kinds:
      - apiGroups: ["database.geekoncloud.com"]
        kinds: ["PostgresInstance"]
  parameters:
    max: 3
```

**Cost controls**: Map sizes to cost tiers. Run a monthly report on all Crossplane-managed resources. You know exactly what exists because it's all in the Kubernetes API.

## Production Considerations

A few things that will bite you if you skip them:

**Drift detection**: Crossplane reconciles continuously by default. If someone modifies an RDS instance in the console, Crossplane reverts it. This is usually what you want, but communicate it clearly.

**Deletion protection**: Set `deletionPolicy: Orphan` on resources during migration periods. Otherwise, deleting the Kubernetes resource deletes the cloud resource.

**Provider upgrades**: Pin provider versions. Test upgrades in staging. Breaking changes happen between minor versions.

**Observability**: Export Crossplane metrics to Prometheus. Alert on `crossplane_managed_resource_ready` dropping below 1 for extended periods.

**State location**: All state lives in etcd. Backup your cluster. Consider Velero for disaster recovery.

Start with one resource type—S3 buckets or simple databases. Get the developer experience right. Add complexity only when teams request it. The goal isn't to abstract everything on day one. It's to eliminate the ticket queue for the resources developers need most.

Your next step: deploy Crossplane to a test cluster, build one Composition for your most-requested resource type, and put it in front of one team. Iterate from their feedback.