---
title: "Multi-Tenant Kubernetes: Namespace Isolation Done Right"
date: 2026-09-08
excerpt: "Build production-grade tenant isolation in Kubernetes using NetworkPolicies, ResourceQuotas, and RBAC. Real configs and security patterns included."
tags: ["kubernetes","multi-tenancy","security","platform-engineering","rbac"]
author: GeekOnCloud
draft: false
---

When your Kubernetes cluster starts serving multiple teams, the "shared namespace with RBAC" approach falls apart fast. I've watched organizations burn weeks debugging why Team A's runaway pod starved Team B's production workload, or why a misconfigured NetworkPolicy leaked traffic between tenants. Multi-tenancy isn't just about slapping namespaces on things—it's about building isolation that actually holds under pressure.

Here's how to build a multi-tenant platform that won't have you firefighting tenant conflicts at 2 AM.

## The Isolation Stack: What Actually Matters

Namespace isolation in Kubernetes is a lie by default. Namespaces are just labels—they don't provide network isolation, resource guarantees, or security boundaries out of the box. You need to layer four things:

1. **Resource quotas and limits** — prevent noisy neighbors
2. **Network policies** — actual traffic isolation
3. **RBAC with namespace scoping** — least-privilege access
4. **Pod security standards** — prevent privilege escalation

Skip any of these, and your "isolated" tenants are one `kubectl exec` or pod network scan away from causing cross-tenant chaos.

## Namespace Structure That Scales

Forget the `team-a`, `team-b` naming convention. It breaks down when teams have multiple environments or when you need to apply policies consistently. Use a hierarchical naming pattern:

```yaml
# Namespace template with required labels and annotations
apiVersion: v1
kind: Namespace
metadata:
  name: acme-payments-prod
  labels:
    tenant: acme
    team: payments
    environment: prod
    cost-center: cc-4521
  annotations:
    scheduler.alpha.kubernetes.io/defaultTolerations: '[{"key":"tenant","operator":"Equal","value":"acme","effect":"NoSchedule"}]'
    contacts.geekoncloud.com/oncall: "payments-oncall@acme.com"
    compliance.geekoncloud.com/pci: "true"
```

The `tenant/team/environment` label structure lets you write policies that target all of Acme's namespaces, just the payments team, or just production workloads. Those labels aren't optional decoration—they're your policy hooks.

For organizations with dozens of tenants, use Hierarchical Namespace Controller (HNC) to create parent-child relationships. Child namespaces inherit RBAC, NetworkPolicies, and ResourceQuotas from parents, cutting your configuration sprawl by 80%.

## Resource Quotas That Actually Prevent Outages

Most teams set ResourceQuotas and call it done. Then a single tenant spins up 50 pods during a load test and exhausts the cluster's CPU requests, blocking every other team's deployments.

Here's a quota setup that covers the gaps people miss:

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: tenant-compute-quota
  namespace: acme-payments-prod
spec:
  hard:
    requests.cpu: "20"
    requests.memory: 40Gi
    limits.cpu: "40"
    limits.memory: 80Gi
    pods: "100"
    count/deployments.apps: "25"
    count/services: "30"
    count/configmaps: "100"
    count/secrets: "50"
    persistentvolumeclaims: "20"
    requests.storage: 500Gi
---
apiVersion: v1
kind: LimitRange
metadata:
  name: tenant-limit-range
  namespace: acme-payments-prod
spec:
  limits:
  - default:
      cpu: 500m
      memory: 512Mi
    defaultRequest:
      cpu: 100m
      memory: 128Mi
    max:
      cpu: "4"
      memory: 8Gi
    min:
      cpu: 50m
      memory: 64Mi
    type: Container
  - max:
      storage: 50Gi
    min:
      storage: 1Gi
    type: PersistentVolumeClaim
```

The LimitRange is critical. Without it, a pod without resource requests/limits counts as zero for quota purposes but still consumes actual resources. I've seen "10 CPU quota" namespaces consuming 40 CPUs because nobody set limits on their pods.

Pro tip: set `count/` quotas on object types. A tenant creating 10,000 ConfigMaps can DoS your etcd even with CPU/memory limits in place.

## Network Isolation With Cilium

Calico works, but Cilium's eBPF-based policies give you L7 visibility and better performance at scale. Here's a deny-all baseline with explicit tenant egress:

```yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: tenant-isolation-baseline
  namespace: acme-payments-prod
spec:
  endpointSelector: {}
  ingress:
  - fromEndpoints:
    - matchLabels:
        io.kubernetes.pod.namespace: acme-payments-prod
  - fromEndpoints:
    - matchLabels:
        k8s:io.kubernetes.pod.namespace: kube-system
        k8s:app: coredns
  egress:
  - toEndpoints:
    - matchLabels:
        io.kubernetes.pod.namespace: acme-payments-prod
  - toEndpoints:
    - matchLabels:
        k8s:io.kubernetes.pod.namespace: kube-system
        k8s:app: coredns
    toPorts:
    - ports:
      - port: "53"
        protocol: UDP
  - toEntities:
    - world
    toPorts:
    - ports:
      - port: "443"
        protocol: TCP
---
apiVersion: cilium.io/v2
kind: CiliumClusterwideNetworkPolicy
metadata:
  name: deny-cross-tenant-traffic
spec:
  endpointSelector:
    matchLabels:
      tenant: acme
  ingressDeny:
  - fromEndpoints:
    - matchExpressions:
      - key: tenant
        operator: Exists
      - key: tenant
        operator: NotIn
        values:
        - acme
```

The cluster-wide policy handles cross-tenant denial at scale—you write it once, and any new tenant automatically can't reach other tenants' workloads. The namespace-scoped policy handles the internal rules.

Test this with `cilium connectivity test` before rolling to production. I've seen too many teams deploy network policies that accidentally blocked their own ingress controllers.

## RBAC: The Part Everyone Gets Wrong

Binding ClusterRoles to namespaces isn't enough. Tenants need different permissions for their own resources versus shared platform resources. Here's the pattern:

```yaml
# Tenant admin - full control within their namespaces
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: tenant-admin
  namespace: acme-payments-prod
rules:
- apiGroups: ["", "apps", "batch", "autoscaling"]
  resources: ["*"]
  verbs: ["*"]
- apiGroups: ["networking.k8s.io"]
  resources: ["ingresses", "networkpolicies"]
  verbs: ["get", "list", "watch", "create", "update", "patch"]
  # No delete on networkpolicies - platform team manages baseline
- apiGroups: [""]
  resources: ["resourcequotas", "limitranges"]
  verbs: ["get", "list", "watch"]
  # Read-only on quotas - prevents self-service footguns
---
# Cross-namespace service discovery (read-only)
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: service-discovery-readonly
rules:
- apiGroups: [""]
  resources: ["services", "endpoints"]
  verbs: ["get", "list", "watch"]
  # Scoped to specific namespaces via RoleBinding
```

The key insight: use Roles (namespaced) for tenant resources and ClusterRoles with namespaced RoleBindings for cross-cutting concerns. Never give tenants ClusterRoleBindings unless you want them reading secrets from every namespace.

## Pod Security: The Last Defense Layer

Pod Security Standards replaced PodSecurityPolicies in Kubernetes 1.25+. Enforce `restricted` baseline for tenant workloads:

```bash
kubectl label namespace acme-payments-prod \
  pod-security.kubernetes.io/enforce=restricted \
  pod-security.kubernetes.io/enforce-version=latest \
  pod-security.kubernetes.io/warn=restricted \
  pod-security.kubernetes.io/audit=restricted
```

This blocks privileged containers, host namespaces, and most privilege escalation vectors. Tenants will complain about not being able to run as root—point them at their Dockerfile and tell them to fix their container hygiene.

For workloads that legitimately need elevated privileges (metrics agents, log collectors), run them in platform-owned namespaces with `privileged` exemptions, not in tenant space.

## What's Next: Platform Automation

Manual namespace provisioning doesn't scale past 20 tenants. Your next step is building a tenant onboarding controller—something that watches a `Tenant` CRD and provisions namespaces, quotas, network policies, and RBAC automatically.

Crossplane or a custom operator using kubebuilder both work well here. The investment pays off when onboarding a new tenant goes from "file a ticket and wait three days" to "merge a PR and deploy."

Start with the isolation controls in this post. Get them deployed, tested, and documented. Then automate the provisioning. Skipping straight to automation without solid isolation foundations is how you end up with 50 tenants and zero actual security.