---
title: "Karpenter Node Autoprovisioning: Cut Kubernetes Costs 40%+"
date: 2026-09-30
excerpt: "Replace Cluster Autoscaler with Karpenter for faster scaling, spot instance optimization, and real cost savings. Includes production configs and benchmarks."
tags: ["kubernetes","karpenter","cost-optimization","aws","autoscaling"]
author: GeekOnCloud
draft: false
---

Every month, I watch teams burn thousands of dollars on Kubernetes nodes that sit 30-40% utilized. The root cause? The Cluster Autoscaler's fundamental design flaw: it reacts to pending pods by scaling node groups you pre-defined. You're essentially guessing what instance types you'll need, creating dozens of node groups, and hoping your predictions match reality.

Karpenter flips this model entirely. Instead of "here are my node groups, find pods that fit," it asks "what do these pods need, and what's the cheapest instance that satisfies them?" This shift from supply-driven to demand-driven provisioning is saving teams 40-60% on compute costs. Let me show you how to implement it.

## Why Cluster Autoscaler Costs You Money

The Cluster Autoscaler operates on a simple loop: pods are pending → find a node group with capacity → scale it up. The problem is the "find a node group" step. You've pre-configured these groups with specific instance types, and the autoscaler picks from your menu.

This creates several cost leaks:

**Over-provisioning by default**: You create node groups with instance types that cover your largest workloads. A pod requesting 256Mi memory lands on a 16GB node because that's what's in your node group.

**Spot instance inflexibility**: To use Spot effectively, you need diversification across many instance types. With Cluster Autoscaler, that means managing 15+ node groups. Most teams give up and use On-Demand.

**Bin-packing gaps**: The autoscaler doesn't optimize for bin-packing across instance types. It scales the node group that can fit the pod, not the most cost-efficient option.

I recently audited a cluster running 47 nodes across 6 node groups. Average utilization: 34%. After migrating to Karpenter with proper constraints, they dropped to 29 nodes at 71% utilization. Same workloads, 38% fewer nodes.

## Karpenter's Provisioning Model

Karpenter watches for unschedulable pods, then provisions the optimal instance type in real-time. No node groups. No pre-defined instance types. It queries AWS (or your cloud provider) for current pricing and availability, then launches exactly what your pods need.

Here's a basic NodePool configuration:

```yaml
apiVersion: karpenter.sh/v1beta1
kind: NodePool
metadata:
  name: default
spec:
  template:
    spec:
      requirements:
        - key: kubernetes.io/arch
          operator: In
          values: ["amd64"]
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["spot", "on-demand"]
        - key: karpenter.k8s.aws/instance-category
          operator: In
          values: ["c", "m", "r"]
        - key: karpenter.k8s.aws/instance-generation
          operator: Gt
          values: ["4"]
      nodeClassRef:
        name: default
  limits:
    cpu: 1000
    memory: 1000Gi
  disruption:
    consolidationPolicy: WhenUnderutilized
    consolidateAfter: 30s
---
apiVersion: karpenter.k8s.aws/v1beta1
kind: EC2NodeClass
metadata:
  name: default
spec:
  amiFamily: AL2
  subnetSelectorTerms:
    - tags:
        karpenter.sh/discovery: "my-cluster"
  securityGroupSelectorTerms:
    - tags:
        karpenter.sh/discovery: "my-cluster"
  instanceProfile: KarpenterNodeInstanceProfile-my-cluster
```

The magic is in `requirements`. Instead of specifying "use m5.xlarge," you're saying "use any current-gen compute, memory, or general-purpose instance." Karpenter considers 50+ instance types and picks the cheapest one that fits your pending pods.

The `consolidationPolicy: WhenUnderutilized` is where real savings happen. Karpenter continuously evaluates whether it can terminate nodes and repack workloads onto fewer, better-utilized instances. This runs every 30 seconds.

## Installation and Migration Strategy

Installing Karpenter requires careful IAM setup. Here's the Terraform configuration for the IAM role:

```hcl
module "karpenter" {
  source  = "terraform-aws-modules/eks/aws//modules/karpenter"
  version = "20.8.4"

  cluster_name = module.eks.cluster_name

  enable_irsa                     = true
  irsa_oidc_provider_arn          = module.eks.oidc_provider_arn
  irsa_namespace_service_accounts = ["karpenter:karpenter"]

  create_node_iam_role = true
  node_iam_role_additional_policies = {
    AmazonSSMManagedInstanceCore = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
  }

  tags = {
    Environment = "production"
  }
}

resource "helm_release" "karpenter" {
  namespace        = "karpenter"
  create_namespace = true
  name             = "karpenter"
  repository       = "oci://public.ecr.aws/karpenter"
  chart            = "karpenter"
  version          = "v0.34.0"

  set {
    name  = "settings.clusterName"
    value = module.eks.cluster_name
  }

  set {
    name  = "settings.clusterEndpoint"
    value = module.eks.cluster_endpoint
  }

  set {
    name  = "serviceAccount.annotations.eks\\.amazonaws\\.com/role-arn"
    value = module.karpenter.iam_role_arn
  }

  set {
    name  = "controller.resources.requests.cpu"
    value = "1"
  }

  set {
    name  = "controller.resources.requests.memory"
    value = "1Gi"
  }
}
```

For migration, don't switch everything at once. Start by deploying Karpenter alongside your existing Cluster Autoscaler. Create a NodePool that only handles specific workloads using node selectors:

```yaml
spec:
  template:
    spec:
      requirements:
        - key: workload-type
          operator: In
          values: ["karpenter-managed"]
```

Label your test workloads with `nodeSelector: { workload-type: karpenter-managed }`. Monitor for a week, verify scheduling works correctly, then gradually migrate more workloads by updating their node selectors.

## Optimizing for Maximum Savings

The default configuration saves money, but these tweaks push savings further:

**Aggressive Spot usage with fallback**: Set Spot as the preferred capacity type but allow On-Demand as fallback:

```yaml
requirements:
  - key: karpenter.sh/capacity-type
    operator: In
    values: ["spot", "on-demand"]
  - key: karpenter.sh/capacity-type
    operator: In
    values: ["spot"]
    weight: 100
```

**Instance size constraints**: Prevent Karpenter from launching tiny instances that create scheduling overhead:

```yaml
requirements:
  - key: karpenter.k8s.aws/instance-size
    operator: NotIn
    values: ["nano", "micro", "small"]
```

**Consolidation tuning**: The default 30-second consolidation window is conservative. For non-production environments:

```yaml
disruption:
  consolidationPolicy: WhenUnderutilized
  consolidateAfter: 0s
```

**Separate NodePools for workload types**: Create different pools for stateless web services (aggressive consolidation, Spot-only) versus stateful workloads (conservative disruption, On-Demand fallback).

## Monitoring and Validating Savings

Install the Karpenter Prometheus metrics and create this Grafana dashboard query to track real savings:

```
sum(karpenter_nodes_total_pod_requests{resource="cpu"}) / sum(karpenter_nodes_allocatable{resource="cpu"}) * 100
```

This shows actual CPU utilization across Karpenter-managed nodes. You should see 65-80% utilization after consolidation settles.

Track these metrics weekly:
- Node count before/after migration
- Average node utilization percentage
- Spot vs On-Demand instance ratio
- Consolidation events per day

Export your AWS Cost Explorer data filtered by the Karpenter node tag. Compare month-over-month EC2 spend for tagged resources.

## What Breaks and How to Fix It

Pod Disruption Budgets (PDBs) will block consolidation if misconfigured. A PDB allowing zero disruptions prevents Karpenter from ever moving that pod. Audit all PDBs and ensure `minAvailable` allows at least one pod to be disrupted.

Spot interruptions require proper handling. Your applications need graceful shutdown logic. Set `terminationGracePeriodSeconds` appropriately and handle SIGTERM. Karpenter gives you a 2-minute warning before Spot termination—use it.

Node startup time affects scheduling latency. Karpenter provisions faster than Cluster Autoscaler, but cold starts still take 60-90 seconds. For latency-sensitive workloads, maintain a small buffer of warm capacity using the `karpenter.sh/do-not-disrupt: "true"` annotation.

Start your migration with a single non-critical workload this week. Deploy Karpenter, create a NodePool scoped to that workload, and watch the consolidation happen. You'll see the cost difference in your next AWS bill.