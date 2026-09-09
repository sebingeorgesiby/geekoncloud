---
title: "Runtime Security in Kubernetes with Falco: Hands-On Guide"
date: 2026-09-09
excerpt: "Deploy Falco for real-time threat detection in K8s. Covers custom rules, syscall monitoring, alerting pipelines, and production tuning with actual configs."
tags: ["kubernetes","falco","runtime-security","container-security","ebpf"]
author: GeekOnCloud
draft: false
---

Your Kubernetes cluster is running. Pods are healthy. Ingress is serving traffic. Everything looks fine — until someone drops a shell into your payment service container and starts exfiltrating data. You won't see it in your deployment manifests. Your admission controllers won't catch it. By the time you notice, it's already over.

This is why runtime security exists. And in the Kubernetes ecosystem, Falco is the de facto standard for detecting threats that slip past your static defenses.

## Why Admission Controllers Aren't Enough

Most teams focus security efforts on the "left" — scanning images, enforcing pod security standards, validating manifests with OPA/Gatekeeper. These are table stakes. But they only protect against known-bad configurations at deploy time.

Runtime threats look different:

- A vulnerability gets exploited in a running container
- An attacker establishes a reverse shell
- Someone reads `/etc/shadow` or writes to `/etc/passwd`
- A process spawns that wasn't in the original image
- Sensitive files get exfiltrated via curl or DNS tunneling

None of these trigger admission webhooks. Your GitOps pipeline sees nothing. Falco watches the actual syscalls happening inside your containers and alerts when something looks wrong.

## How Falco Actually Works

Falco uses eBPF (or a kernel module on older systems) to tap directly into Linux syscalls. Every `open()`, `execve()`, `connect()`, and `write()` gets inspected against a rule engine. When a syscall matches a rule condition, Falco fires an alert.

The architecture is straightforward:

1. **Falco driver** (eBPF probe or kernel module) captures syscalls
2. **Falco engine** processes events against rules
3. **Outputs** send alerts to stdout, files, HTTP endpoints, or message queues

The eBPF approach is strongly preferred — no kernel module compilation, better security isolation, and it works on most modern kernels (5.8+). If you're running GKE, EKS, or AKS with recent node images, you're covered.

## Deploying Falco with Helm

Skip the manual manifests. The Falco Helm chart handles driver selection, RBAC, and DaemonSet configuration:

```bash
helm repo add falcosecurity https://falcosecurity.github.io/charts
helm repo update

helm install falco falcosecurity/falco \
  --namespace falco \
  --create-namespace \
  --set driver.kind=ebpf \
  --set falcosidekick.enabled=true \
  --set falcosidekick.webui.enabled=true \
  --set collectors.kubernetes.enabled=true
```

This gives you:

- Falco DaemonSet running on every node
- eBPF driver (auto-downloads appropriate probe)
- Falcosidekick for alert routing
- Kubernetes metadata enrichment (pod names, namespaces, labels)

Verify the driver loaded correctly:

```bash
kubectl logs -n falco -l app.kubernetes.io/name=falco | grep -i "driver"
# Should show: "eBPF probe loaded successfully"
```

## Writing Rules That Actually Matter

Falco ships with a default ruleset covering common threats. But the defaults are noisy. You'll get alerts for every `kubectl exec` and every debugging session. The real work is tuning rules for your environment.

Here's a custom rules file that focuses on high-signal detections:

```yaml
# custom-rules.yaml
customRules:
  custom-rules.yaml: |-
    - rule: Reverse Shell Detected
      desc: Detects reverse shell patterns commonly used in attacks
      condition: >
        spawned_process and 
        proc.name in (bash, sh, zsh, dash) and
        (proc.cmdline contains "/dev/tcp" or
         proc.cmdline contains "nc -e" or
         proc.cmdline contains "ncat -e" or
         proc.cmdline contains "mkfifo")
      output: >
        Reverse shell detected 
        (user=%user.name command=%proc.cmdline container=%container.name 
         pod=%k8s.pod.name namespace=%k8s.ns.name image=%container.image.repository)
      priority: CRITICAL
      tags: [network, shell, mitre_execution]

    - rule: Crypto Miner Binary Detected
      desc: Detects execution of known cryptomining software
      condition: >
        spawned_process and 
        proc.name in (xmrig, minerd, cpuminer, cgminer, ethminer)
      output: >
        Cryptominer execution detected 
        (process=%proc.name pod=%k8s.pod.name namespace=%k8s.ns.name)
      priority: CRITICAL
      tags: [cryptomining, mitre_impact]

    - rule: Sensitive File Read in Container
      desc: Detects reading of sensitive credential files
      condition: >
        open_read and 
        container and
        fd.name in (/etc/shadow, /etc/gshadow, /root/.ssh/id_rsa, /root/.aws/credentials) and
        not proc.name in (sshd, sudo)
      output: >
        Sensitive file accessed 
        (file=%fd.name process=%proc.name pod=%k8s.pod.name namespace=%k8s.ns.name)
      priority: WARNING
      tags: [filesystem, credential_access]

    - rule: Container Drift Detected
      desc: New executable run that wasn't in the original image
      condition: >
        spawned_process and 
        container and
        proc.is_exe_upper_layer=true and
        not proc.name in (apt, apt-get, yum, dnf, pip, npm)
      output: >
        Container drift - new executable not in original image
        (process=%proc.name pod=%k8s.pod.name namespace=%k8s.ns.name)
      priority: WARNING
      tags: [container, drift_detection]
```

Apply with Helm:

```bash
helm upgrade falco falcosecurity/falco \
  --namespace falco \
  -f custom-rules.yaml
```

The container drift rule is particularly valuable. It catches attackers who download and execute malware after compromising a container — something image scanning can never detect.

## Reducing Noise Without Missing Threats

Default Falco generates a lot of alerts. The trick is aggressive allowlisting for known-good behavior while maintaining coverage.

Use macros to define your baseline:

```yaml
customRules:
  exceptions.yaml: |-
    - macro: allowed_kubectl_exec_pods
      condition: >
        k8s.ns.name in (kube-system, monitoring) or
        k8s.pod.name startswith "debug-"

    - macro: allowed_package_management
      condition: >
        (k8s.ns.name = "ci" and container.image.repository endswith "/builder") or
        proc.pname = "tini"

    - rule: Terminal Shell in Container
      append: true
      condition: and not allowed_kubectl_exec_pods
```

The pattern: start with default rules enabled, collect alerts for a week, identify false positives, add specific exceptions. Never disable entire rule categories — you'll blind yourself to real attacks.

## Routing Alerts to Your Stack

Falcosidekick transforms Falco's stdout alerts into actionable notifications. Configure it to hit your existing tooling:

```yaml
# values-sidekick.yaml
falcosidekick:
  enabled: true
  config:
    slack:
      webhookurl: "https://hooks.slack.com/services/XXX/YYY/ZZZ"
      channel: "#security-alerts"
      minimumpriority: "warning"
    
    elasticsearch:
      hostport: "https://elasticsearch.logging.svc:9200"
      index: "falco"
      minimumpriority: "notice"
    
    prometheus:
      enabled: true  # Exposes metrics at /metrics
```

With Prometheus metrics enabled, you can alert on alert rates:

```promql
# Alert if critical Falco events exceed threshold
rate(falco_events{priority="Critical"}[5m]) > 0.1
```

This catches scenarios where Falco is firing but nobody's watching the Slack channel.

## Operationalizing Runtime Security

Running Falco is step one. Making it useful requires process:

**Triage workflow**: Critical alerts (reverse shells, miners) go to PagerDuty. Warning alerts go to a security queue reviewed daily. Notice-level goes to long-term storage for forensics.

**Response runbooks**: When Falco fires, what do you do? At minimum: isolate the pod (`kubectl cordon` the node, delete the pod), capture forensic data (memory dump, file system snapshot), investigate the attack vector.

**Baseline validation**: Monthly, intentionally trigger Falco rules in a test namespace. Run a reverse shell command. Read `/etc/shadow`. Verify alerts fire and reach your monitoring stack.

**Performance monitoring**: Falco's eBPF probe adds ~1-2% CPU overhead per node. Monitor `falco_*` metrics for drops or failures. If you see `falco_kernel_drops_total` climbing, you're missing events.

The next step: Deploy Falco to a non-production cluster today. Let it run for 48 hours with default rules. Review the output. You'll either find nothing interesting (good — now tune for less noise) or you'll find something that makes you very glad you looked (also good, but scarier). Either outcome proves the value.