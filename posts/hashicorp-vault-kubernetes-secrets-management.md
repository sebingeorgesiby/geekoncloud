---
title: "HashiCorp Vault on Kubernetes: Production Secrets Management"
date: 2026-05-28
excerpt: "Deploy Vault on K8s with auto-unseal, injector sidecars, and dynamic secrets. Real configs and commands for production-grade secrets management."
tags: ["kubernetes","vault","secrets-management","hashicorp","security"]
author: GeekOnCloud
draft: false
---

Running secrets in Kubernetes without a proper secrets manager is like storing your house keys under the doormat — technically functional, but asking for trouble. Kubernetes Secrets are base64-encoded (not encrypted), visible to anyone with cluster access, and scattered across namespaces like digital confetti. HashiCorp Vault fixes this by centralizing secret management, providing audit logs, automatic rotation, and dynamic credentials that expire. Here's how to deploy it properly on Kubernetes and integrate it with your workloads.

## Why Vault Over Native Kubernetes Secrets

Before we dive into the setup, let's be clear about what you're gaining. Kubernetes Secrets have three fundamental problems: they're stored in etcd (which may or may not be encrypted at rest depending on your cluster config), they lack audit trails, and they're static — someone has to manually rotate them.

Vault addresses all three. Secrets are encrypted with a configurable backend (transit, auto-unseal via AWS KMS, etc.), every access is logged, and dynamic secrets mean your database credentials can have a 1-hour TTL. When that Pod dies, those credentials become useless. An attacker who grabs your DB password from memory has 59 minutes until it's worthless.

Real numbers: In a production cluster I managed, switching to Vault with dynamic PostgreSQL credentials reduced our secret rotation incidents from ~12/year (manual rotations we forgot) to zero. The secrets just expire.

## Deploying Vault with the Official Helm Chart

Skip the manifests — use the official Helm chart. It handles HA setup, service accounts, and PodDisruptionBudgets correctly.

```bash
helm repo add hashicorp https://helm.releases.hashicorp.com
helm repo update

# Create namespace
kubectl create namespace vault

# Install with HA mode and Raft storage
helm install vault hashicorp/vault \
  --namespace vault \
  --set server.ha.enabled=true \
  --set server.ha.replicas=3 \
  --set server.ha.raft.enabled=true \
  --set server.dataStorage.size=10Gi \
  --set server.dataStorage.storageClass=gp3 \
  --set injector.enabled=true \
  --set injector.replicas=2

# Check pod status (they'll be 0/1 until initialized)
kubectl get pods -n vault
```

The pods will stay unready until you initialize and unseal Vault. This is intentional — Vault starts sealed and needs explicit action to become operational.

```bash
# Initialize Vault (only on first pod, only once ever)
kubectl exec -n vault vault-0 -- vault operator init \
  -key-shares=5 \
  -key-threshold=3 \
  -format=json > vault-init.json

# CRITICAL: Store vault-init.json securely (AWS Secrets Manager, 1Password, etc.)
# This contains your unseal keys and root token. Lose it = rebuild Vault from scratch.

# Unseal each pod (need 3 of 5 keys)
UNSEAL_KEY_1=$(cat vault-init.json | jq -r '.unseal_keys_b64[0]')
UNSEAL_KEY_2=$(cat vault-init.json | jq -r '.unseal_keys_b64[1]')
UNSEAL_KEY_3=$(cat vault-init.json | jq -r '.unseal_keys_b64[2]')

for pod in vault-0 vault-1 vault-2; do
  kubectl exec -n vault $pod -- vault operator unseal $UNSEAL_KEY_1
  kubectl exec -n vault $pod -- vault operator unseal $UNSEAL_KEY_2
  kubectl exec -n vault $pod -- vault operator unseal $UNSEAL_KEY_3
done
```

For production, enable auto-unseal with AWS KMS or GCP Cloud KMS. Manual unsealing after every pod restart is operationally painful and will wake you up at 3 AM.

## Configuring Kubernetes Authentication

Vault needs to trust your Kubernetes cluster. The Kubernetes auth method lets Pods authenticate to Vault using their ServiceAccount tokens — no hardcoded credentials needed.

```bash
# Port-forward to Vault (or use Ingress)
kubectl port-forward -n vault svc/vault 8200:8200 &

# Login with root token (from vault-init.json)
export VAULT_ADDR="http://127.0.0.1:8200"
export VAULT_TOKEN=$(cat vault-init.json | jq -r '.root_token')

# Enable Kubernetes auth
vault auth enable kubernetes

# Configure it to talk to the Kubernetes API
vault write auth/kubernetes/config \
  kubernetes_host="https://kubernetes.default.svc:443"
```

Now create a policy and role for your application. Let's say you have an app called `payment-service` that needs database credentials:

```hcl
# policy-payment-service.hcl
path "database/creds/payment-db-role" {
  capabilities = ["read"]
}

path "secret/data/payment-service/*" {
  capabilities = ["read", "list"]
}
```

```bash
# Write the policy
vault policy write payment-service policy-payment-service.hcl

# Create a Kubernetes auth role
vault write auth/kubernetes/role/payment-service \
  bound_service_account_names=payment-service \
  bound_service_account_namespaces=production \
  policies=payment-service \
  ttl=1h
```

This role says: "Only the `payment-service` ServiceAccount in the `production` namespace can authenticate, and they get the `payment-service` policy with a 1-hour token TTL."

## Injecting Secrets into Pods with the Agent Sidecar

The Vault Agent Injector watches for pods with specific annotations and automatically injects a sidecar that handles authentication and secret fetching. Your application reads secrets from the filesystem — no Vault SDK required.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-service
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: payment-service
  template:
    metadata:
      labels:
        app: payment-service
      annotations:
        vault.hashicorp.com/agent-inject: "true"
        vault.hashicorp.com/role: "payment-service"
        vault.hashicorp.com/agent-inject-secret-db-creds: "database/creds/payment-db-role"
        vault.hashicorp.com/agent-inject-template-db-creds: |
          {{- with secret "database/creds/payment-db-role" -}}
          export DB_USER="{{ .Data.username }}"
          export DB_PASS="{{ .Data.password }}"
          {{- end }}
        vault.hashicorp.com/agent-inject-secret-config: "secret/data/payment-service/config"
        vault.hashicorp.com/agent-inject-template-config: |
          {{- with secret "secret/data/payment-service/config" -}}
          export API_KEY="{{ .Data.data.api_key }}"
          export STRIPE_SECRET="{{ .Data.data.stripe_secret }}"
          {{- end }}
    spec:
      serviceAccountName: payment-service
      containers:
        - name: payment-service
          image: myregistry/payment-service:v2.3.1
          command: ["/bin/sh", "-c"]
          args:
            - source /vault/secrets/db-creds && source /vault/secrets/config && ./payment-service
          resources:
            limits:
              memory: "512Mi"
              cpu: "500m"
```

The injector adds an init container that pre-fetches secrets before your app starts, plus a sidecar that keeps them refreshed. Secrets land in `/vault/secrets/` as files. The template format above makes them sourceable as environment variables, but you could also write JSON, YAML, or raw values.

## Dynamic Database Credentials Setup

Static secrets are fine for API keys, but database credentials should be dynamic. Vault can generate PostgreSQL users on-demand with automatic expiration.

```bash
# Enable database secrets engine
vault secrets enable database

# Configure PostgreSQL connection
vault write database/config/payment-db \
  plugin_name=postgresql-database-plugin \
  allowed_roles="payment-db-role" \
  connection_url="postgresql://{{username}}:{{password}}@postgres.production.svc:5432/payments?sslmode=require" \
  username="vault_admin" \
  password="initial-password-change-me"

# Rotate the root password (Vault now manages it, you don't know it)
vault write -force database/rotate-root/payment-db

# Create a role that generates credentials
vault write database/roles/payment-db-role \
  db_name=payment-db \
  creation_statements="CREATE ROLE \"{{name}}\" WITH LOGIN PASSWORD '{{password}}' VALID UNTIL '{{expiration}}'; GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO \"{{name}}\";" \
  default_ttl="1h" \
  max_ttl="24h"
```

Now when your Pod authenticates to Vault and reads `database/creds/payment-db-role`, it gets a unique username/password pair that expires in 1 hour. The Vault sidecar automatically refreshes these before expiration. Your PostgreSQL ends up with users like `v-k8s-payment-db-role-xyz123` that come and go — and if you're ever breached, attackers are chasing credentials that keep disappearing.

## Monitoring and Alerting

Vault without monitoring is flying blind. At minimum, scrape these Prometheus metrics:

- `vault_core_unsealed` — alert if this drops to 0 (Vault sealed)
- `vault_expire_num_leases` — track lease count, alert on sudden spikes
- `vault_runtime_alloc_bytes` — memory usage, helps capacity planning

Add audit logging to catch suspicious access patterns:

```bash
vault audit enable file file_path=/vault/audit/audit.log
```

Ship these logs to your SIEM. Every secret read, every authentication attempt, every policy change — it's all there.

## Where to Go Next

You've got Vault running in HA mode with Kubernetes auth and dynamic database credentials. The next step is setting up AWS auto-unseal to eliminate manual intervention during pod restarts — run `vault operator init` with `-recovery-shares` and `-recovery-threshold` flags, and configure the `seal` stanza in your Helm values to use `awskms`. This turns your unseal keys into recovery keys (for emergencies only) while AWS KMS handles automatic unsealing. That's the difference between a production-grade setup and something that pages you at midnight.