---
title: "Runtime Security in Kubernetes with Falco: Detection Guide"
date: 2026-10-29
excerpt: "Deploy Falco for real-time threat detection in K8s. Custom rules, Sidekick integration, and tuning for production workloads with actual alert examples."
tags: ["kubernetes","falco","runtime-security","threat-detection","cloud-security"]
author: GeekOnCloud
draft: false
---

You've got your Kubernetes cluster locked down. Network policies are tight, RBAC is configured, pod security standards are enforced. Then someone exploits a vulnerability in your application code, spawns a reverse shell from inside a running container, and you don't notice until the AWS bill arrives. Static security controls can't catch runtime threats — you need eyes inside your containers while they're running.

Falco is the de facto standard for Kubernetes runtime security. It uses eBPF (or a kernel module on older systems) to tap into system calls at the kernel level, watching everything your containers do in real-time. When a container does something suspicious — like spawning a shell, reading `/etc/shadow`, or making an unexpected network connection — Falco catches it and alerts you.

## How Falco Actually Works

Falco instruments the Linux kernel to intercept system calls before they complete. Every `open()`, `execve()`, `connect()`, and `write()` flows through Falco's rule engine. This happens at the kernel level, so containers can't hide from it — there's no way for malicious code inside a container to bypass or tamper with Falco's monitoring.

The architecture is straightforward: a driver (eBPF probe or kernel module) captures syscalls, the userspace Falco engine evaluates them against rules, and alerts fire when rules match. The eBPF approach is preferred now — it's safer (no kernel module loading), faster, and supported on kernels 4.14+.

Rules use a simple syntax that filters on syscall fields:

```yaml
- rule: Shell Spawned in Container
  desc: Detect shell execution in a container
  condition: >
    spawned_process and 
    container and 
    shell_procs and
    not shell_in_container_allowed
  output: >
    Shell spawned in container 
    (user=%user.name container=%container.name shell=%proc.name 
     parent=%proc.pname cmdline=%proc.cmdline)
  priority: WARNING
  tags: [container, shell, mitre_execution]
```

The `condition` uses Falco's filtering language — `spawned_process` is a macro for process execution syscalls, `container` checks if we're in a container context, `shell_procs` matches common shells like bash/sh/zsh.

## Deploying Falco on Kubernetes

Helm is the fastest path to production:

```bash
helm repo add falcosecurity https://falcosecurity.github.io/charts
helm repo update

helm install falco falcosecurity/falco \
  --namespace falco \
  --create-namespace \
  --set falcosidekick.enabled=true \
  --set falcosidekick.webui.enabled=true \
  --set driver.kind=ebpf \
  --set collectors.kubernetes.enabled=true \
  --set falco.grpc.enabled=true \
  --set falco.grpcOutput.enabled=true
```

This deploys Falco as a DaemonSet (one pod per node), enables Falcosidekick for routing alerts, and uses the eBPF driver. The Kubernetes collector enriches events with pod names, namespaces, and labels — critical for making sense of alerts in a busy cluster.

Verify it's working:

```bash
kubectl get pods -n falco
kubectl logs -n falco -l app.kubernetes.io/name=falco -f
```

Now trigger a test alert:

```bash
kubectl run test-shell --rm -it --image=alpine -- /bin/sh -c "cat /etc/shadow"
```

You should see Falco log an alert about reading sensitive files. If you're using Falcosidekick with the webui, check `http://<sidekick-webui-svc>:2802` for a dashboard view.

## Writing Custom Rules That Actually Matter

The default ruleset catches obvious stuff — shells in containers, sensitive file access, unexpected network tools. But real security requires rules tuned to your environment. Generic rules create noise; specific rules catch attackers.

Here's a rule that detects cryptocurrency mining — a common post-compromise activity:

```yaml
- rule: Cryptocurrency Mining Detected
  desc: Detect crypto mining processes by process name or arguments
  condition: >
    spawned_process and container and
    (proc.name in (xmrig, minerd, cpuminer, cgminer, bfgminer) or
     proc.cmdline contains "stratum+tcp" or
     proc.cmdline contains "pool.minexmr" or
     proc.cmdline contains "nicehash")
  output: >
    Crypto mining detected (user=%user.name container=%container.name 
    image=%container.image.repository command=%proc.cmdline)
  priority: CRITICAL
  tags: [container, cryptomining, mitre_impact]
```

Another practical rule — detect containers making unexpected outbound connections. Most containers shouldn't be initiating connections to random IPs:

```yaml
- rule: Unexpected Outbound Connection
  desc: Container connecting to non-approved external IPs
  condition: >
    outbound and container and
    not fd.sip in (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16) and
    not (k8s.ns.name = "kube-system")
  output: >
    Unexpected outbound connection 
    (namespace=%k8s.ns.name pod=%k8s.pod.name image=%container.image.repository 
     connection=%fd.name)
  priority: WARNING
  tags: [network, container, exfiltration]
```

Create a ConfigMap with custom rules and mount it into Falco:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: falco-custom-rules
  namespace: falco
data:
  custom_rules.yaml: |
    # Your rules here
```

Then update your Helm values to load them:

```yaml
falco:
  rulesFile:
    - /etc/falco/falco_rules.yaml
    - /etc/falco/k8s_audit_rules.yaml
    - /etc/falco/rules.d/custom_rules.yaml
```

## Routing Alerts to Your Stack

Falco generating alerts is useless if nobody sees them. Falcosidekick handles routing to basically any destination — Slack, PagerDuty, Elasticsearch, Loki, AWS SecurityHub, you name it.

Configure Slack alerts by updating Falcosidekick's values:

```yaml
falcosidekick:
  config:
    slack:
      webhookurl: "https://hooks.slack.com/services/XXX/YYY/ZZZ"
      minimumpriority: "warning"
      outputformat: "all"
```

For Elasticsearch/OpenSearch integration (query alerts alongside your application logs):

```yaml
falcosidekick:
  config:
    elasticsearch:
      hostport: "https://elasticsearch.logging:9200"
      index: "falco"
      type: "_doc"
      minimumpriority: "notice"
```

In production, I route WARNING and above to Slack for visibility, CRITICAL to PagerDuty for on-call, and everything to Elasticsearch for forensics. The `minimumpriority` setting per output prevents alert fatigue — you don't need a page for every informational event.

## Performance and Operational Reality

Falco's overhead is measurable but acceptable: expect 1-3% CPU per node under normal workloads, spiking during syscall-heavy operations. The eBPF driver is lighter than the kernel module, and you can tune the event buffer size if you're dropping events:

```yaml
falco:
  bufferedOutputs: true
  outputs:
    rate: 0
    maxBurst: 1000
```

Rate limiting outputs prevents Falco itself from becoming a denial-of-service vector during an incident — an attacker flooding syscalls shouldn't be able to overwhelm your alerting pipeline.

Watch for these operational issues:

1. **Rule tuning takes time**. The first week will be noisy. Whitelist legitimate behaviors using `exceptions` in rules rather than disabling rules entirely.

2. **Node kernel versions matter**. eBPF features vary by kernel version. Pin your node AMIs/images and test Falco compatibility before cluster upgrades.

3. **High-cardinality containers cause pain**. If you're running thousands of short-lived containers (CI/CD runners, batch jobs), Falco's container metadata tracking adds memory pressure. Tune `metadata_download` settings accordingly.

## What's Next

You've got runtime visibility now. The immediate next step: spend a week tuning rules for your specific workloads. Run Falco in "log-only" mode, review the alerts, and add exceptions for legitimate behavior until your signal-to-noise ratio is usable.

After that, integrate Falco with your incident response workflow. Falco tells you something bad is happening — you need runbooks for what happens next. Automatic pod termination via Falcosidekick's response capabilities is possible but dangerous; start with alerts and manual response until you trust your rules.

Clone the [Falco rules repository](https://github.com/falcosecurity/rules) and read through the default ruleset. Understanding how the existing rules work will make you significantly better at writing your own. The real value of runtime security comes from rules tailored to your environment — generic detection is just the starting point.