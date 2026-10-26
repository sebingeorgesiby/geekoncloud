---
title: "Kubernetes Image Pre-Pulling: Cut Pod Startup Time by 80%"
date: 2026-10-26
excerpt: "Stop waiting for image pulls during deployments. Learn DaemonSets, warm-up jobs, and registry caching strategies that slash K8s pod startup from minutes to seconds."
tags: ["kubernetes","container-optimization","devops","performance-tuning","docker"]
author: GeekOnCloud
draft: false
---

You spin up a new node in your Kubernetes cluster. The pod gets scheduled. Then you wait. And wait. For 45 seconds, sometimes two minutes, your application sits there while containerd pulls a 1.2GB image from your registry. Your autoscaler triggered because traffic spiked, but by the time the pod is actually running, the spike has passed. Sound familiar?

Image pull time is the silent killer of Kubernetes responsiveness. In a world where we obsess over shaving milliseconds off container startup, we routinely ignore the elephant in the room: pulling images from a registry can take 10-100x longer than actually starting the container.

Let's fix that.

## Understanding the Real Cost of Image Pulls

Before we solve this, let's quantify the problem. On a typical EKS node with standard networking to ECR:

- Alpine-based image (~50MB): 3-8 seconds
- Standard application image (~500MB): 15-30 seconds  
- ML/Data science image (~2-5GB): 60-180 seconds

These numbers assume your registry is in the same region and you're not hitting rate limits. Cross-region pulls? Double it. Docker Hub during a rate limit window? Add another 30 seconds of backoff.

The real pain hits during cluster scale-up events. Your Cluster Autoscaler provisions a fresh node, the kubelet starts, and suddenly you're pulling every single image that node needs from scratch. No layer caching, no warm registry connections, nothing.

I've seen production incidents where the autoscaler provisioned nodes fast enough, but image pulls meant pods weren't actually ready for 3+ minutes. The HPA kept screaming for more replicas, the autoscaler kept adding nodes, and the registry started throttling. Cascade failure from image pulls.

## Pre-Pulling Images During Node Bootstrap

The most straightforward approach: pull images before the kubelet marks the node as ready. You intercept the node bootstrap process and pre-populate the container runtime's image cache.

For EKS, you modify your launch template's user data:

```bash
#!/bin/bash
set -e

# Standard EKS bootstrap arguments
B64_CLUSTER_CA="$B64_CLUSTER_CA"
API_SERVER_URL="$API_SERVER_URL"
CLUSTER_NAME="$CLUSTER_NAME"

# Pre-pull critical images BEFORE joining the cluster
IMAGES=(
    "your-registry.com/api-server:v2.3.1"
    "your-registry.com/worker:v1.8.0"
    "602401143452.dkr.ecr.us-west-2.amazonaws.com/amazon-k8s-cni:v1.12.0"
    "602401143452.dkr.ecr.us-west-2.amazonaws.com/eks/kube-proxy:v1.28.1"
)

# Authenticate to ECR (if using ECR)
aws ecr get-login-password --region us-west-2 | nerdctl login --username AWS --password-stdin your-registry.com

# Pull images in parallel
printf '%s\n' "${IMAGES[@]}" | xargs -P 4 -I {} nerdctl pull {}

# Now bootstrap the node
/etc/eks/bootstrap.sh $CLUSTER_NAME \
    --b64-cluster-ca $B64_CLUSTER_CA \
    --apiserver-endpoint $API_SERVER_URL
```

The key detail: we pull *before* calling the bootstrap script. The kubelet won't register the node until bootstrap completes, so your pre-pulled images are ready when pods get scheduled.

For GKE, the equivalent goes in your instance template's startup script. For self-managed clusters, add it to your cloud-init or Ignition config.

## Using DaemonSets for Ongoing Image Warming

Bootstrap pre-pulling handles new nodes, but what about image updates? You push a new tag, deploy it to staging, then production—and every node needs to pull the new image.

A DaemonSet-based image puller keeps your nodes warm:

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: image-prepuller
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: image-prepuller
  template:
    metadata:
      labels:
        app: image-prepuller
    spec:
      # Run on all nodes including control plane if needed
      tolerations:
        - operator: Exists
      # Minimal resources - we're not actually running these containers
      initContainers:
        - name: prepull-api
          image: your-registry.com/api-server:v2.3.1
          command: ['echo', 'pulled']
          resources:
            requests:
              cpu: 1m
              memory: 1Mi
        - name: prepull-worker  
          image: your-registry.com/worker:v1.8.0
          command: ['echo', 'pulled']
          resources:
            requests:
              cpu: 1m
              memory: 1Mi
      containers:
        - name: pause
          image: k8s.gcr.io/pause:3.9
          resources:
            requests:
              cpu: 1m
              memory: 1Mi
      priorityClassName: system-node-critical
```

This DaemonSet runs an init container for each image you want pre-pulled. The container immediately exits after `echo 'pulled'`, but the image is now in the node's cache. The main container is just a pause container to keep the DaemonSet happy.

When you update an image tag, update the DaemonSet. Kubernetes rolls it out, each node pulls the new images during the init container phase, and by the time your real deployment rolls out, images are already cached.

## Spegel: Peer-to-Peer Image Distribution

For larger clusters, there's a better approach than hammering your registry from every node: peer-to-peer image distribution with Spegel.

Spegel (Swedish for "mirror") runs as a DaemonSet and turns your cluster into a distributed image cache. When node A needs an image that node B already has, it pulls directly from node B instead of hitting the external registry.

The math is compelling. 100-node cluster, 1GB image, 10Gbps link to registry:
- Traditional: 100 nodes × 1GB = 100GB transferred, ~80 seconds per node if serialized
- With Spegel: First node pulls from registry, other 99 pull from peers within the cluster

Install with Helm:

```bash
helm install spegel oci://ghcr.io/spegel-org/helm-charts/spegel \
  --namespace spegel \
  --create-namespace \
  --set spegel.containerdSock=/run/containerd/containerd.sock \
  --set spegel.registries='["https://docker.io","https://ghcr.io","https://your-registry.com"]'
```

Spegel modifies containerd's configuration to use the local Spegel instance as a registry mirror. When containerd requests an image, Spegel checks the local node first, then queries peers via mDNS (or optionally, the Kubernetes API), and only falls back to the external registry if no peer has the image.

For air-gapped or bandwidth-constrained clusters, this is transformative. I've seen image pull times drop from 45 seconds to under 3 seconds once an image is available on any node in the cluster.

## Measuring the Impact

Before and after numbers from a real production cluster (EKS, m5.xlarge nodes, ECR in same region):

**Without pre-pulling:**
- Node registration to first pod ready: 87 seconds average
- Image pull time (500MB app image): 23 seconds average
- Autoscaling response time: 110 seconds

**With bootstrap pre-pulling + Spegel:**
- Node registration to first pod ready: 34 seconds average
- Image pull time: 1.8 seconds average (cache hit)
- Autoscaling response time: 52 seconds

That 58-second improvement in autoscaling response time means the difference between users experiencing degraded performance and not noticing anything at all.

Monitor this with the `kubelet_container_image_pull_duration_seconds` metric. Set up alerts for pulls exceeding your SLO—if p99 image pull time creeps above 30 seconds, you know your pre-warming isn't covering all your workloads.

## What to Actually Do Monday Morning

Here's your action plan:

1. **Audit your largest images.** Run `crictl images` on a production node and sort by size. Anything over 500MB is a candidate for pre-pulling.

2. **Add the top 5 images to your node bootstrap script.** Start with your most frequently deployed applications and critical system components.

3. **Deploy a DaemonSet pre-puller for your application images.** Wire it into your CI/CD so image updates to staging trigger DaemonSet updates.

4. **If you have more than 20 nodes, evaluate Spegel.** The peer-to-peer distribution pays dividends quickly at scale.

5. **Add the kubelet image pull metric to your dashboards.** You can't improve what you don't measure.

Image pull optimization isn't glamorous work. Nobody gets promoted for reducing containerd pull times. But it's the kind of unsexy infrastructure improvement that compounds—faster autoscaling, better reliability during incidents, lower registry bills. The 30 minutes you spend implementing this will pay back every single time your cluster scales.