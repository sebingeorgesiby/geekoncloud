---
title: "Kubernetes Network Policies: Zero-Trust Networking Done Right"
date: 2026-09-28
excerpt: "Implement zero-trust networking in K8s with network policies. Real configs, CNI comparisons, and patterns that actually block lateral movement."
tags: ["kubernetes","network-policies","zero-trust","microservices-security","calico"]
author: GeekOnCloud
draft: false
---

Most Kubernetes clusters I audit have the same problem: every pod can talk to every other pod. Your frontend can reach your database directly. A compromised logging sidecar can probe your payment service. Network policies exist to fix this, but fewer than 20% of production clusters actually use them effectively. Let's change that.

## The Default Kubernetes Network Model Is Wide Open

Out of the box, Kubernetes implements a flat network. Every pod gets an IP, and every pod can reach every other pod across namespaces. This made sense for simplicity during adoption, but it's a security nightmare in production.

Think about what this means: if an attacker compromises your least-secured pod—maybe a debug container someone left running, or a vulnerable image in a dev namespace—they can immediately probe your entire cluster. No lateral movement techniques required. They're already inside.

Network policies are Kubernetes-native firewall rules that restrict pod-to-pod traffic. They're namespace-scoped, label-based, and work at L3/L4 (IP and port). But here's the catch: they're opt-in, and they require a CNI that actually enforces them. Flannel in its default mode? Doesn't enforce policies. You need Calico, Cilium, Weave Net, or a cloud provider's CNI with policy support.

## Your First Policy: Default Deny Everything

The zero-trust starting point is explicit: deny all traffic, then whitelist what's needed. Here's the foundation every namespace should have:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: production
spec:
  podSelector: {}  # Empty selector matches all pods
  policyTypes:
    - Ingress
    - Egress
```

This policy matches all pods in the `production` namespace (empty `podSelector` means "everything") and blocks both incoming and outgoing traffic. Deploy this, and your namespace goes dark. Nothing can talk to anything.

Now you layer on explicit allows. Here's a realistic example for a three-tier app—frontend, API, and database:

```yaml
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: api-policy
  namespace: production
spec:
  podSelector:
    matchLabels:
      app: api
      tier: backend
  policyTypes:
    - Ingress
    - Egress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app: frontend
        - namespaceSelector:
            matchLabels:
              name: monitoring
          podSelector:
            matchLabels:
              app: prometheus
      ports:
        - protocol: TCP
          port: 8080
  egress:
    - to:
        - podSelector:
            matchLabels:
              app: postgres
              tier: database
      ports:
        - protocol: TCP
          port: 5432
    - to:  # Allow DNS
        - namespaceSelector: {}
          podSelector:
            matchLabels:
              k8s-app: kube-dns
      ports:
        - protocol: UDP
          port: 53
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: postgres-policy
  namespace: production
spec:
  podSelector:
    matchLabels:
      app: postgres
      tier: database
  policyTypes:
    - Ingress
    - Egress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app: api
              tier: backend
      ports:
        - protocol: TCP
          port: 5432
  egress: []  # Database doesn't initiate connections
```

Notice the DNS rule in egress. This trips up everyone. Block egress without allowing DNS, and your pods can't resolve service names. They'll sit there failing with "could not resolve host" while you wonder why your allow rule isn't working.

## Namespace Isolation for Multi-Tenant Clusters

In clusters running multiple teams or environments, namespace isolation is non-negotiable. You don't want your staging environment accidentally hitting production databases, and you definitely don't want team-alpha's compromised pod scanning team-beta's services.

First, label your namespaces:

```bash
kubectl label namespace production environment=production
kubectl label namespace staging environment=staging
kubectl label namespace team-alpha team=alpha
kubectl label namespace team-beta team=beta
```

Then create policies that only allow same-namespace traffic plus specific cross-namespace exceptions:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: namespace-isolation
  namespace: team-alpha
spec:
  podSelector: {}
  policyTypes:
    - Ingress
  ingress:
    - from:
        - podSelector: {}  # Same namespace only (no namespaceSelector = current namespace)
    - from:
        - namespaceSelector:
            matchLabels:
              name: monitoring  # Allow monitoring namespace
        - namespaceSelector:
            matchLabels:
              name: ingress-nginx  # Allow ingress controllers
```

The subtle distinction: when you specify only `podSelector` without `namespaceSelector`, it implicitly means "current namespace only." Add `namespaceSelector: {}` and suddenly you're matching all namespaces.

## Debugging Network Policies Without Losing Your Mind

Network policies fail silently. Traffic just doesn't arrive, no error logs, no rejection messages. Here's my debugging workflow:

**Step 1: Verify your CNI supports policies**

```bash
kubectl get pods -n kube-system | grep -E 'calico|cilium|weave'
```

If you see flannel and nothing else, your policies are decorative YAML that does nothing.

**Step 2: Check what policies apply to a pod**

```bash
kubectl get networkpolicies -n production -o yaml | \
  grep -A 50 "podSelector" | \
  head -100
```

**Step 3: Test connectivity from inside a pod**

```bash
# Spin up a debug pod
kubectl run debug --rm -it --image=nicolaka/netshoot -- /bin/bash

# From inside, test connections
curl -v --connect-timeout 5 api-service.production.svc.cluster.local:8080
nc -zv postgres-service.production.svc.cluster.local 5432
```

**Step 4: Use Cilium's policy verdict if you're on Cilium**

```bash
cilium monitor --type policy-verdict
```

This shows real-time policy decisions—which rules matched, what got allowed or denied.

## Beyond L3/L4: When You Need L7 Policies

Standard Kubernetes NetworkPolicy operates at the IP and port level. It can't distinguish between `GET /api/users` and `DELETE /api/admin`. For HTTP-aware policies, you need a service mesh or extended CNI.

Cilium's CiliumNetworkPolicy supports L7 rules:

```yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: api-l7-policy
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: api
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
              - method: "GET"
                path: "/api/public/.*"
              - method: "POST"
                path: "/api/users"
                headers:
                  - 'X-Auth-Token: [a-zA-Z0-9]+'
```

This policy allows the frontend to GET anything under `/api/public/` and POST to `/api/users` only if the request includes an `X-Auth-Token` header. The same pod, same port—but now with request-level control.

Istio achieves similar results through AuthorizationPolicy resources, but you're taking on significant complexity. For most teams, standard L3/L4 policies cover 90% of security requirements.

## Rolling Out Policies in Production

Don't deploy default-deny policies at 2 PM on a Tuesday. Here's the safe rollout:

1. **Audit current traffic** using Cilium Hubble, Calico flow logs, or a service mesh's observability features. Know what talks to what before you start blocking.

2. **Deploy policies in "log-only" mode** if your CNI supports it. Cilium lets you set `policy-audit-mode: enabled` to see what would be blocked without actually blocking.

3. **Start with egress controls** since they're less likely to break user-facing traffic immediately.

4. **Add ingress rules progressively**, starting with the most isolated backend services.

5. **Monitor aggressively** for the first 48 hours. Watch for connection timeout metrics and failed health checks.

The goal isn't perfect policies on day one—it's iterative tightening without outages.

---

Start tomorrow: pick one namespace, deploy the default-deny policy, then add explicit allows for the traffic you know is legitimate. Use `kubectl logs` and your monitoring stack to find what breaks. In a week, you'll have a segmented namespace. In a month, you'll wonder how you ever ran without this.