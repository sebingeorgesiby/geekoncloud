---
title: LitmusChaos on Kubernetes: Practical Chaos Engineering Guide
date: 2026-04-29
excerpt: Deploy LitmusChaos on K8s, run pod-kill and network chaos experiments, and build resilient systems. Real configs and YAML examples included.
tags: ["chaos-engineering","kubernetes","litmus","site-reliability","resilience-testing"]
author: GeekOnCloud
draft: false
---

Your Kubernetes cluster runs perfectly in staging. Deploys are green, pods are healthy, metrics look clean. Then production hits 3x traffic on Black Friday, a node goes down, and suddenly you discover your app doesn't handle graceful degradation—it cascades into a full outage. Chaos engineering exists to find these failures before your customers do. LitmusChaos is the CNCF's answer to bringing this discipline natively into Kubernetes.

## Why LitmusChaos Over Alternatives

The chaos engineering space has options: Gremlin (commercial), Chaos Monkey (Netflix's original), PowerfulSeal, and Chaos Mesh. LitmusChaos wins for Kubernetes-native workflows because it's built entirely on CRDs and operators. Your chaos experiments become version-controlled YAML alongside your application manifests. It also integrates directly with Argo Workflows, Keptn, and GitOps pipelines without bolting on external schedulers.

LitmusChaos operates on a hub model—ChaosHub hosts pre-built experiments for common failure scenarios. Need to kill a pod? There's an experiment. Stress CPU on a node? Done. Inject network latency between services? Already written. You're not building experiments from scratch; you're customizing parameters on battle-tested chaos definitions.

The architecture matters: LitmusChaos runs a control plane (litmus-portal) for experiment orchestration and visibility, while chaos-operator handles the actual injection. Experiments run as Kubernetes jobs with specific RBAC permissions, meaning blast radius is controlled by standard K8s primitives you already understand.

## Installing LitmusChaos on Your Cluster

Skip the Helm chart complexity for initial exploration. The kubectl-based install gives you a working setup in under two minutes:

```bash
# Create the litmus namespace
kubectl create ns litmus

# Install LitmusChaos operator and CRDs
kubectl apply -f https://litmuschaos.github.io/litmus/3.0.0/litmus-3.0.0.yaml -n litmus

# Verify pods are running
kubectl get pods -n litmus -w

# Access the portal (default creds: admin/litmus)
kubectl port-forward svc/litmusportal-frontend-service 9091:9091 -n litmus
```

For production, you'll want the Helm chart with custom values for persistence, ingress, and resource limits:

```bash
helm repo add litmuschaos https://litmuschaos.github.io/litmus-helm/
helm install litmus litmuschaos/litmus \
  --namespace litmus \
  --set portal.server.service.type=ClusterIP \
  --set mongodb.persistence.enabled=true \
  --set mongodb.persistence.size=20Gi
```

The portal gives you a web UI for designing experiments, but the real power is the CRD-based approach. Everything you do in the UI generates YAML you can export and commit to Git.

## Your First Chaos Experiment: Pod Delete

Start simple. The pod-delete experiment validates that your application recovers when Kubernetes reschedules a pod—something that happens constantly in real clusters due to node failures, evictions, and rolling updates.

Create a `ChaosEngine` resource targeting your application:

```yaml
apiVersion: litmuschaos.io/v1alpha1
kind: ChaosEngine
metadata:
  name: nginx-chaos
  namespace: default
spec:
  appinfo:
    appns: 'default'
    applabel: 'app=nginx'
    appkind: 'deployment'
  engineState: 'active'
  chaosServiceAccount: litmus-admin
  experiments:
    - name: pod-delete
      spec:
        components:
          env:
            - name: TOTAL_CHAOS_DURATION
              value: '30'
            - name: CHAOS_INTERVAL
              value: '10'
            - name: FORCE
              value: 'false'
            - name: PODS_AFFECTED_PERC
              value: '50'
        probe:
          - name: 'check-nginx-accessible'
            type: 'httpProbe'
            mode: 'Continuous'
            runProperties:
              probeTimeout: 5
              retry: 2
              interval: 5
            httpProbe/inputs:
              url: 'http://nginx-service.default.svc:80'
              method:
                get:
                  criteria: '=='
                  responseCode: '200'
```

The critical piece here is the probe. Without it, you're just breaking things. The httpProbe continuously checks whether your service remains accessible while chaos runs. If responses fail, the experiment marks itself as failed—giving you a clear signal that your application didn't handle the failure gracefully.

Apply it with `kubectl apply -f chaos-engine.yaml`. The experiment creates a chaos runner pod that executes the pod-delete logic according to your parameters. Watch it with `kubectl get chaosresult nginx-chaos-pod-delete -o yaml` to see pass/fail status.

## Graduating to Network Chaos

Pod deletion is table stakes. Real distributed systems failures come from network partitions, latency spikes, and packet loss. LitmusChaos injects these at the kernel level using tc (traffic control) and iptables.

A realistic scenario: your microservice calls an external payment API with a 5-second timeout. What happens when that API responds in 6 seconds consistently? Does your service return errors gracefully, or does it queue up requests until memory exhausts?

```yaml
apiVersion: litmuschaos.io/v1alpha1
kind: ChaosEngine
metadata:
  name: network-latency-test
  namespace: default
spec:
  appinfo:
    appns: 'default'
    applabel: 'app=payment-service'
    appkind: 'deployment'
  engineState: 'active'
  chaosServiceAccount: litmus-admin
  experiments:
    - name: pod-network-latency
      spec:
        components:
          env:
            - name: NETWORK_INTERFACE
              value: 'eth0'
            - name: TARGET_CONTAINER
              value: 'payment-service'
            - name: NETWORK_LATENCY
              value: '6000'  # 6 seconds in milliseconds
            - name: DESTINATION_IPS
              value: '10.0.0.50'  # Your payment API endpoint
            - name: TOTAL_CHAOS_DURATION
              value: '120'
```

Run this against your payment service while load testing. You'll discover whether your circuit breakers actually trip, whether your retry logic causes thundering herds, and whether your UI degrades gracefully or shows spinning loaders forever.

## Integrating Chaos into CI/CD

Chaos experiments belong in your pipeline, not as ad-hoc manual tests. The pattern: deploy to a staging environment, run smoke tests, inject chaos, validate resilience, promote to production.

With GitHub Actions and LitmusChaos:

```yaml
- name: Run Chaos Experiment
  run: |
    kubectl apply -f chaos-experiments/pod-delete.yaml
    # Wait for experiment completion
    kubectl wait --for=condition=complete chaosengine/app-chaos --timeout=300s -n staging
    # Check result
    RESULT=$(kubectl get chaosresult app-chaos-pod-delete -n staging -o jsonpath='{.status.experimentStatus.verdict}')
    if [ "$RESULT" != "Pass" ]; then
      echo "Chaos experiment failed - blocking deployment"
      exit 1
    fi
```

The key insight: chaos experiments should have success criteria. "We broke something" isn't the goal. "We broke something and the system recovered within SLO" is the goal. Define your probes to measure what matters—response times staying under p99 thresholds, error rates staying below 1%, downstream services remaining unaffected.

## Observability During Chaos

Running experiments blind is useless. Before triggering chaos, ensure you have dashboards showing:

- Request rate, error rate, and latency (RED metrics) for affected services
- Pod restart counts and OOMKill events
- Upstream and downstream service health
- Resource utilization (CPU, memory, network I/O)

LitmusChaos integrates with Prometheus through ServiceMonitors. The chaos-exporter exposes metrics like `litmuschaos_experiment_verdict` and `litmuschaos_experiment_duration` that you can alert on.

Create a Grafana dashboard with annotations marking chaos experiment windows. When you review incidents later, you'll immediately see whether chaos was running—eliminating confusion about whether observed failures were intentional.

## Moving Forward

Start with experiments matching real incidents you've experienced. If you've had node failures cause outages, run node-drain experiments. If network issues between services caused cascading failures, inject latency between those specific services. Chaos engineering isn't about random destruction—it's about systematically validating that your systems handle the failures you know will happen.

Your next step: pick one critical service, write one chaos experiment with a meaningful probe, and run it in staging tomorrow. Commit the experiment YAML to your infrastructure repo. You'll learn more about your system's failure modes in 30 minutes than months of reading runbooks.