---
title: "Multi-cluster GitOps with Argo CD ApplicationSets"
date: 2026-10-05
excerpt: "Deploy to 50+ clusters from one repo. Real ApplicationSet generators, cluster selectors, and patterns we use to manage fleet-wide rollouts."
tags: ["argocd","gitops","kubernetes","multi-cluster","applicationsets"]
author: GeekOnCloud
draft: false
---

Managing a single Kubernetes cluster with GitOps is straightforward. Scale to five clusters across three clouds, and suddenly you're copy-pasting Application manifests, fighting drift between environments, and spending more time on YAML than actual engineering. Argo CD's ApplicationSets solve this by generating Applications dynamically from templates—but most tutorials stop at the basics. Let's build a production-grade multi-cluster GitOps setup that actually scales.

## The Problem with Manual Multi-Cluster Management

Before ApplicationSets, managing applications across multiple clusters meant one of two approaches: duplicate Application manifests for each cluster (maintenance nightmare), or complex Helm/Kustomize overlays that become their own kind of technical debt.

Consider deploying a monitoring stack to 12 clusters. That's 12 nearly-identical Application resources, each with subtle differences in cluster URLs, namespaces, or configuration values. When you need to update the Helm chart version, you're touching 12 files. Miss one? Congratulations, you've got drift.

ApplicationSets flip this model. You define a template once, specify generators that produce parameter sets, and Argo CD creates Applications automatically. Add a new cluster? It gets the application. Remove a cluster? The Application disappears. This is GitOps at the fleet level.

## Setting Up Your ApplicationSet Foundation

First, let's establish the infrastructure. You need Argo CD installed on a management cluster with credentials for all target clusters. The ApplicationSet controller ships with Argo CD since v2.0, so no separate installation required.

Register your clusters with Argo CD:

```bash
# Add clusters using their kubeconfig contexts
argocd cluster add eks-prod-us-east-1 --name prod-us-east-1
argocd cluster add eks-prod-eu-west-1 --name prod-eu-west-1
argocd cluster add gke-staging-us-central1 --name staging-us-central1

# Verify registration
argocd cluster list
```

Each registered cluster gets stored as a Secret in the `argocd` namespace. This is where generators pull cluster information from—cluster name, API server URL, and any labels you've attached.

Label your clusters for intelligent targeting:

```bash
# Add metadata labels to cluster secrets
kubectl label secret prod-us-east-1 -n argocd environment=production region=us-east-1
kubectl label secret prod-eu-west-1 -n argocd environment=production region=eu-west-1
kubectl label secret staging-us-central1 -n argocd environment=staging region=us-central1
```

## Generator Strategies for Real Workloads

The cluster generator is just the beginning. Production deployments typically combine multiple generators to handle complex requirements.

Here's an ApplicationSet that deploys different configurations based on environment:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: platform-monitoring
  namespace: argocd
spec:
  generators:
    - matrix:
        generators:
          # First generator: select clusters
          - clusters:
              selector:
                matchExpressions:
                  - key: environment
                    operator: In
                    values: ["production", "staging"]
          # Second generator: configuration variants
          - list:
              elements:
                - component: prometheus
                  chartVersion: "25.8.0"
                - component: grafana
                  chartVersion: "7.0.17"
                - component: alertmanager
                  chartVersion: "1.7.0"
  template:
    metadata:
      name: '{{component}}-{{name}}'
      labels:
        app.kubernetes.io/component: '{{component}}'
        cluster: '{{name}}'
    spec:
      project: platform
      source:
        repoURL: https://prometheus-community.github.io/helm-charts
        targetRevision: '{{chartVersion}}'
        chart: '{{component}}'
        helm:
          valueFiles:
            - values/{{component}}/base.yaml
            - values/{{component}}/{{metadata.labels.environment}}.yaml
      destination:
        server: '{{server}}'
        namespace: monitoring
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=true
        retry:
          limit: 5
          backoff:
            duration: 5s
            factor: 2
            maxDuration: 3m
```

This matrix generator creates Applications for every combination of cluster and component. Six clusters times three components equals 18 Applications from one manifest. The value files path uses cluster labels, so production clusters pull `values/prometheus/production.yaml` while staging gets `values/prometheus/staging.yaml`.

## Handling Environment-Specific Configuration

The Git generator shines when applications need per-cluster customization beyond simple labels. Structure your Git repository to hold cluster-specific configs:

```
clusters/
├── prod-us-east-1/
│   ├── config.json
│   └── apps/
├── prod-eu-west-1/
│   ├── config.json
│   └── apps/
└── staging-us-central1/
    ├── config.json
    └── apps/
```

Each `config.json` contains cluster-specific parameters:

```json
{
  "cluster": {
    "name": "prod-us-east-1",
    "environment": "production",
    "ingress_class": "alb",
    "storage_class": "gp3",
    "domain": "prod.us-east-1.example.com"
  }
}
```

The Git generator reads these files and passes values to your template:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: cluster-apps
  namespace: argocd
spec:
  generators:
    - git:
        repoURL: https://github.com/org/cluster-configs.git
        revision: main
        files:
          - path: "clusters/*/config.json"
  template:
    metadata:
      name: 'apps-{{cluster.name}}'
    spec:
      project: default
      source:
        repoURL: https://github.com/org/k8s-apps.git
        targetRevision: main
        path: 'apps/{{cluster.environment}}'
        helm:
          parameters:
            - name: ingress.class
              value: '{{cluster.ingress_class}}'
            - name: persistence.storageClass
              value: '{{cluster.storage_class}}'
            - name: global.domain
              value: '{{cluster.domain}}'
      destination:
        server: https://{{cluster.name}}.example.com:6443
        namespace: applications
```

Adding a new cluster means creating a directory with `config.json`. That's it. No changes to ApplicationSets, no PRs against infrastructure repos.

## Progressive Rollout Strategies

Deploying simultaneously to all clusters is rarely what you want in production. Use the rollout strategy with cluster ordering:

```yaml
spec:
  strategy:
    type: RollingSync
    rollingSync:
      steps:
        - matchExpressions:
            - key: environment
              operator: In
              values: ["staging"]
        - matchExpressions:
            - key: environment
              operator: In
              values: ["production"]
            - key: region
              operator: In
              values: ["us-east-1"]
          maxUpdate: 1
        - matchExpressions:
            - key: environment
              operator: In
              values: ["production"]
```

This deploys to staging first, then rolls through production starting with us-east-1 (one cluster at a time), before hitting remaining production clusters. If staging fails health checks, production never sees the change.

## Scaling Considerations and Gotchas

At 50+ clusters, ApplicationSets start hitting performance considerations. The controller reconciles all ApplicationSets every three minutes by default. With complex generators querying Git repositories or external APIs, this creates load.

Tune reconciliation frequency in the `argocd-cm` ConfigMap:

```yaml
data:
  applicationsetcontroller.enable.progressive.syncs: "true"
  applicationsetcontroller.policy: sync
  applicationsetcontroller.reconcile.timeout: 3m
```

Watch for these production issues:

**Orphaned Applications**: If a generator stops producing a cluster (removed from Git, label changed), the Application gets deleted—along with its resources. Set `preserveResourcesOnDeletion: true` if this isn't desired behavior.

**Secret proliferation**: Each Application needs credentials for its destination cluster. With 100 Applications hitting 20 clusters, you've got secrets being accessed constantly. Use the `argocd-repo-server` caching effectively.

**Diff calculation overhead**: Large ApplicationSets with frequent Git changes spike CPU on `argocd-application-controller`. Spread load by splitting into multiple ApplicationSets by team or domain.

## Your Next Move

Start with one ApplicationSet managing a single application across all environments. Pick something low-risk—a metrics agent or log shipper. Get comfortable with generators, understand the template parameters available, then expand. 

Once that's stable, convert your most duplicated Application manifests to ApplicationSets. You'll immediately see the reduction in YAML and the increase in consistency.

The Git generator plus matrix combinations handle 90% of real-world scenarios. Master those before reaching for external generators or plugins. The complexity ceiling is high, but you don't need to hit it on day one.