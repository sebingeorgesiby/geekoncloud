---
title: "Kubernetes Network Policies: Zero-Trust Networking Guide"
date: 2026-06-04
excerpt: "Implement zero-trust security in K8s with network policies. Real YAML configs, Calico/Cilium examples, and production-tested deny-all patterns."
tags: ["kubernetes","network-security","zero-trust","calico","microservices"]
author: GeekOnCloud
draft: false
---

Most Kubernetes clusters run with a dirty secret: every pod can talk to every other pod. Your payment service can reach your debug containers. Your compromised nginx pod can scan your entire internal network. By default, Kubernetes networking is completely flat and permissive — the opposite of zero-trust.

Network policies fix this. They're the firewall rules of Kubernetes, letting you define exactly which pods can communicate with which other pods, on which ports. Yet most teams skip them entirely because they seem complex. They're not. Let's build a proper zero-trust network for your microservices.

## The Default Kubernetes Network Model Is Broken (By Design)

Kubernetes networking follows a simple rule: every pod gets an IP, and every pod can reach every other pod. No NAT, no firewalls, no restrictions. This made sense for simplicity but creates a massive blast radius when something gets compromised.

Here's what your cluster looks like without network policies:

```bash
# From any pod, you can reach any other pod
kubectl run debug --image=nicolaka/netshoot --rm -it -- /bin/bash

# Inside the pod - scan your entire cluster
nmap -sT -p 80,443,5432,6379,27017 10.0.0.0/16
# You'll find every exposed service: databases, caches, internal APIs
```

An attacker who compromises a single pod — through a vulnerable dependency, SSRF, or container escape — can now laterally move to your database, your secrets manager sidecar, or your monitoring stack. Network policies create the segmentation that stops this.

## How Network Policies Actually Work

A NetworkPolicy is a Kubernetes resource that selects pods using labels and defines allowed ingress (incoming) and egress (outgoing) traffic. The moment you apply your first policy to a pod, that pod switches from "allow all" to "deny all except what's explicitly allowed."

Critical concept: policies are additive. If you have three policies selecting the same pod, the pod can do anything any of those policies allow. You can't write a "deny" rule — you can only write "allow" rules, and everything else is implicitly denied.

Here's a complete, production-ready policy for a typical web application:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: api-server-policy
  namespace: production
spec:
  podSelector:
    matchLabels:
      app: api-server
  policyTypes:
    - Ingress
    - Egress
  ingress:
    # Allow traffic from ingress controller only
    - from:
        - namespaceSelector:
            matchLabels:
              name: ingress-nginx
          podSelector:
            matchLabels:
              app.kubernetes.io/name: ingress-nginx
      ports:
        - protocol: TCP
          port: 8080
    # Allow Prometheus scraping
    - from:
        - namespaceSelector:
            matchLabels:
              name: monitoring
          podSelector:
            matchLabels:
              app: prometheus
      ports:
        - protocol: TCP
          port: 9090
  egress:
    # Allow DNS resolution
    - to:
        - namespaceSelector: {}
          podSelector:
            matchLabels:
              k8s-app: kube-dns
      ports:
        - protocol: UDP
          port: 53
    # Allow database access
    - to:
        - podSelector:
            matchLabels:
              app: postgres
      ports:
        - protocol: TCP
          port: 5432
    # Allow Redis cache
    - to:
        - podSelector:
            matchLabels:
              app: redis
      ports:
        - protocol: TCP
          port: 6379
```

Notice the DNS egress rule. This trips up everyone on their first network policy deployment. Without explicit DNS access, your pods can't resolve any hostnames — including your database service names. The `kube-dns` (or `coredns`) label selector is mandatory for any pod that needs to resolve DNS.

## Building a Default-Deny Foundation

Zero-trust starts with default-deny. Apply these two policies to every namespace before deploying any workloads:

```yaml
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-ingress
spec:
  podSelector: {}
  policyTypes:
    - Ingress
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-egress
spec:
  podSelector: {}
  policyTypes:
    - Egress
```

The empty `podSelector: {}` matches all pods in the namespace. Now nothing can communicate — not even DNS. This is intentional. You'll add specific allow policies for each workload.

For DNS to work cluster-wide, add this policy to every namespace:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-dns-egress
spec:
  podSelector: {}
  policyTypes:
    - Egress
  egress:
    - to:
        - namespaceSelector: {}
          podSelector:
            matchLabels:
              k8s-app: kube-dns
      ports:
        - protocol: UDP
          port: 53
        - protocol: TCP
          port: 53
```

## CNI Requirements: Not All Network Plugins Support Policies

Here's the catch that breaks production deployments: NetworkPolicy resources are just YAML without a CNI that enforces them. The default `kubenet` plugin ignores them entirely. Your policies exist but do nothing.

CNIs that enforce network policies:
- **Calico** — Most common choice, excellent policy support, includes its own extended policy CRDs
- **Cilium** — eBPF-based, supports L7 policies (HTTP path filtering), identity-based policies
- **Weave Net** — Simpler setup, basic policy support
- **Antrea** — VMware's CNI, solid policy enforcement

CNIs that don't enforce policies:
- **Flannel** — Most popular, zero policy support
- **AWS VPC CNI** — Requires Calico sidecar for policies
- **Azure CNI** — Needs Azure Network Policy Manager addon

Check if your cluster actually enforces policies:

```bash
# Deploy a test workload with a deny-all policy
kubectl create namespace policy-test
kubectl apply -f - <<EOF
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: deny-all
  namespace: policy-test
spec:
  podSelector: {}
  policyTypes:
    - Ingress
    - Egress
EOF

kubectl run test-pod --namespace=policy-test --image=nginx
kubectl run client --namespace=policy-test --image=nicolaka/netshoot --rm -it -- curl test-pod

# If curl succeeds, your CNI isn't enforcing policies
```

## Debugging Network Policy Failures

When pods stop communicating after applying policies, you need systematic debugging:

```bash
# List all policies affecting a pod
kubectl get networkpolicies -n production -o yaml | grep -A 50 "podSelector"

# Check if the CNI is logging drops (Calico example)
kubectl logs -n calico-system -l k8s-app=calico-node | grep -i deny

# Verify pod labels match policy selectors
kubectl get pod api-server-abc123 -o jsonpath='{.metadata.labels}' | jq .

# Test connectivity from inside a pod
kubectl exec -it api-server-abc123 -- nc -zv postgres-service 5432
```

Common failure patterns:
1. **Missing DNS egress** — Pods can't resolve service names
2. **Label mismatch** — Policy selector doesn't match pod labels (case-sensitive!)
3. **Namespace selector missing** — Cross-namespace traffic needs both `namespaceSelector` and `podSelector`
4. **Port mismatch** — Policy allows port 80 but app runs on 8080

## Graduating to Cilium L7 Policies

Standard network policies work at L3/L4 — IP addresses and ports. Cilium extends this to L7, letting you write policies based on HTTP paths, methods, and headers:

```yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: api-l7-policy
spec:
  endpointSelector:
    matchLabels:
      app: api-server
  ingress:
    - fromEndpoints:
        - matchLabels:
            app: frontend
      toPorts:
        - ports:
            - port: "8080"
              protocol: TCP
          rules:
            http:
              - method: GET
                path: "/api/v1/users.*"
              - method: POST
                path: "/api/v1/orders"
```

Now the frontend can only access specific API endpoints. A compromised frontend pod trying to hit `/api/v1/admin` gets blocked at the network layer, not the application layer.

## Your Next Step

Deploy default-deny policies to a staging namespace today. Apply them, watch what breaks, and add explicit allow rules for each communication path. You'll discover connections you didn't know existed — debugging jobs talking to production databases, legacy pods phoning home to deprecated services. 

Start with one namespace. Document every allow rule you add. That documentation becomes your network architecture diagram — accurate because it's enforced by code, not assumed from a whiteboard sketch.