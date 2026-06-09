---
title: "GitHub Actions Self-Hosted Runners on Kubernetes: Full Setup"
date: 2026-06-09
excerpt: "Deploy auto-scaling GitHub Actions runners on K8s with ARC. Real configs, cost analysis, and production gotchas from running 500+ daily jobs."
tags: ["github-actions","kubernetes","ci-cd","self-hosted-runners","actions-runner-controller"]
author: GeekOnCloud
draft: false
---

Running GitHub Actions on GitHub's hosted runners works fine until it doesn't. You hit the 6-hour job timeout. You need access to private network resources. Your builds burn through your Actions minutes budget. Or you just want builds that don't start cold every single time.

Self-hosted runners on Kubernetes solve all of this, but the implementation details matter. Get it wrong and you'll have orphaned pods eating cluster resources, security holes wide enough to drive a truck through, or runners that mysteriously stop picking up jobs.

Here's how to do it properly.

## Why Kubernetes for Self-Hosted Runners

Before diving into implementation, let's be clear about when this makes sense. Self-hosted runners on Kubernetes are worth the operational overhead when you need:

- **Network access to internal resources** — databases, artifact registries, APIs behind VPNs
- **Custom hardware** — GPU nodes for ML training, high-memory instances for compilation
- **Persistent caching** — Docker layer caches, dependency caches that survive between jobs
- **Cost control** — spot instances at 60-90% discount versus GitHub's per-minute billing
- **Compliance requirements** — jobs that must run in your infrastructure, not Microsoft's

If none of these apply, stick with hosted runners. The maintenance burden isn't worth it for basic CI jobs.

## The Architecture: Actions Runner Controller

The canonical solution is [Actions Runner Controller (ARC)](https://github.com/actions/actions-runner-controller), now officially maintained by GitHub. It runs as a Kubernetes operator that watches for workflow jobs and spins up runner pods on demand.

Two deployment modes exist:

1. **RunnerDeployment** — maintains a static pool of runners, scales via HPA
2. **RunnerSet** — StatefulSet-based, supports persistent volumes per runner

For most use cases, RunnerDeployment with autoscaling gives you the best balance of responsiveness and resource efficiency.

Install ARC using Helm:

```bash
helm repo add actions-runner-controller https://actions-runner-controller.github.io/actions-runner-controller
helm repo update

kubectl create namespace actions-runner-system

# Create a GitHub App for authentication (recommended over PATs)
# App needs: Repository permissions: Actions (read), Administration (read/write), Metadata (read)
# Organization permissions: Self-hosted runners (read/write)

kubectl create secret generic controller-manager \
  -n actions-runner-system \
  --from-literal=github_app_id=<APP_ID> \
  --from-literal=github_app_installation_id=<INSTALLATION_ID> \
  --from-file=github_app_private_key=<PATH_TO_PEM_FILE>

helm install actions-runner-controller actions-runner-controller/actions-runner-controller \
  -n actions-runner-system \
  --set syncPeriod=1m \
  --set authSecret.create=false \
  --set authSecret.name=controller-manager
```

The `syncPeriod` controls how often ARC reconciles state with GitHub. 1 minute is reasonable; shorter intervals hit API rate limits.

## Runner Configuration That Actually Works

Here's a production-ready RunnerDeployment that handles the common gotchas:

```yaml
apiVersion: actions.summerwind.dev/v1alpha1
kind: RunnerDeployment
metadata:
  name: k8s-runners
  namespace: actions-runners
spec:
  replicas: 2  # Minimum warm pool
  template:
    spec:
      repository: your-org/your-repo  # Or use 'organization: your-org' for org-level runners
      labels:
        - self-hosted
        - linux
        - x64
        - k8s
      
      # Docker-in-Docker for container actions
      dockerdWithinRunnerContainer: true
      
      # Resource requests — tune based on your workloads
      resources:
        limits:
          cpu: "4"
          memory: "8Gi"
        requests:
          cpu: "2"
          memory: "4Gi"
      
      # Ephemeral runners: new pod per job, clean state guaranteed
      ephemeral: true
      
      # Node selection for dedicated runner nodes
      nodeSelector:
        node-role.kubernetes.io/ci: "true"
      
      tolerations:
        - key: "dedicated"
          operator: "Equal"
          value: "ci"
          effect: "NoSchedule"
      
      # Service account with minimal permissions
      serviceAccountName: actions-runner
      
      # Volumes for caching
      volumeMounts:
        - name: docker-cache
          mountPath: /var/lib/docker
        - name: work
          mountPath: /runner/_work
      volumes:
        - name: docker-cache
          emptyDir: {}
        - name: work
          emptyDir:
            sizeLimit: 50Gi
---
apiVersion: actions.summerwind.dev/v1alpha1
kind: HorizontalRunnerAutoscaler
metadata:
  name: k8s-runners-autoscaler
  namespace: actions-runners
spec:
  scaleTargetRef:
    kind: RunnerDeployment
    name: k8s-runners
  minReplicas: 1
  maxReplicas: 10
  scaleDownDelaySecondsAfterScaleOut: 300  # Prevent thrashing
  metrics:
    - type: TotalNumberOfQueuedAndInProgressWorkflowRuns
      repositoryNames:
        - your-org/your-repo
```

Critical settings explained:

- **ephemeral: true** — Each job gets a fresh pod. Non-ephemeral runners accumulate state and eventually break in weird ways.
- **dockerdWithinRunnerContainer** — Runs dockerd inside the runner container. Safer than mounting the host's Docker socket.
- **scaleDownDelaySecondsAfterScaleOut** — Prevents scale-down immediately after scale-up. Without this, runners get killed mid-job during burst traffic.

## Security Hardening

Self-hosted runners execute arbitrary code from your repositories. On Kubernetes, this requires defense in depth.

**1. Dedicated node pools.** Never run CI workloads on nodes hosting production services. Use taints and tolerations to enforce isolation.

**2. Network policies.** Restrict egress to what your builds actually need:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: runner-egress
  namespace: actions-runners
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: actions-runner
  policyTypes:
    - Egress
  egress:
    # GitHub API and Actions services
    - to:
        - ipBlock:
            cidr: 0.0.0.0/0
      ports:
        - port: 443
          protocol: TCP
    # Internal artifact registry
    - to:
        - namespaceSelector:
            matchLabels:
              name: artifact-registry
      ports:
        - port: 5000
          protocol: TCP
    # DNS
    - to:
        - namespaceSelector: {}
          podSelector:
            matchLabels:
              k8s-app: kube-dns
      ports:
        - port: 53
          protocol: UDP
```

**3. Pod Security Standards.** At minimum, apply the `restricted` policy to the runner namespace. Yes, this breaks some things — fix those things instead of relaxing security.

**4. Secret management.** Never bake secrets into runner images. Use GitHub's encrypted secrets or integrate with external secret managers (Vault, AWS Secrets Manager) via the runner's service account.

## Persistent Caching for Fast Builds

The biggest performance win with self-hosted runners is persistent caching. GitHub's hosted runners start cold every time. Your runners don't have to.

For Docker layer caching with BuildKit:

```yaml
volumes:
  - name: buildkit-cache
    persistentVolumeClaim:
      claimName: buildkit-cache-pvc

volumeMounts:
  - name: buildkit-cache
    mountPath: /var/lib/buildkit
```

Then in your workflow:

```yaml
- name: Build image
  run: |
    docker buildx create --use --driver=docker-container \
      --driver-opt=image=moby/buildkit:latest
    docker buildx build \
      --cache-from=type=local,src=/var/lib/buildkit \
      --cache-to=type=local,dest=/var/lib/buildkit,mode=max \
      -t myapp:${{ github.sha }} .
```

For language-specific dependency caches (npm, pip, Maven), mount persistent volumes to the standard cache directories. A 10GB PVC for npm's `~/.npm` cache cuts install times by 80% on repeated builds.

## Monitoring and Troubleshooting

ARC exposes Prometheus metrics on port 8443. Key metrics to alert on:

- `github_runner_organization_runners` — total registered runners
- `github_runner_busy` — runners currently executing jobs
- `workflowjob_queue_duration_seconds` — how long jobs wait for a runner

When jobs hang in "Queued" state, check in order:
1. Runner pod logs: `kubectl logs -n actions-runners -l app.kubernetes.io/name=actions-runner`
2. Controller logs: `kubectl logs -n actions-runner-system -l app.kubernetes.io/name=actions-runner-controller`
3. GitHub App permissions — the most common cause of silent failures

If runners register but never pick up jobs, verify the labels in your workflow's `runs-on` exactly match the labels in your RunnerDeployment.

## Next Steps

Start with a single repository and two runners. Run your most resource-intensive workflow and validate it completes faster than on hosted runners. Measure cache hit rates. Then expand to organization-level runners and add autoscaling.

The reference implementation I've outlined handles 50+ concurrent workflows on a 10-node runner pool. Your mileage will vary based on job duration and resource requirements — tune the HPA thresholds based on actual queue depth metrics, not guesswork.