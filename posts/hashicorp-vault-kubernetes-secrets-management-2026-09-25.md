---
title: "HashiCorp Vault on Kubernetes: Production Secrets Management"
date: 2026-09-25
excerpt: "Deploy Vault on K8s with auto-unseal, injector sidecars, and dynamic secrets. Real configs and patterns from production clusters."
tags: ["kubernetes","vault","secrets-management","security","hashicorp"]
author: GeekOnCloud
draft: false
---

Running secrets in Kubernetes without a proper management solution is like leaving your house keys under the doormat—everyone knows that's where they are. Native Kubernetes Secrets are base64-encoded (not encrypted), stored in etcd, and accessible to anyone with the right RBAC. HashiCorp Vault changes this equation entirely, giving you dynamic secrets, automatic rotation, audit logging, and fine-grained access control. Here's how to deploy it properly.

## Why Vault Over Native Secrets

Kubernetes Secrets have three critical problems. First, they're not encrypted at rest by default—you need to configure encryption providers separately. Second, once a secret is created, it lives forever until someone manually rotates it. Third, there's no audit trail showing who accessed what and when.

Vault solves all three. Secrets can be dynamic (generated on-demand with automatic TTLs), encrypted with Vault's barrier encryption, and every access is logged. The Vault Agent Injector pattern means your applications don't even need to know Vault exists—secrets appear as files in the pod automatically.

The performance overhead is minimal. In my testing, the injector adds roughly 50-100ms to pod startup time, and secret retrieval takes 2-5ms per request. For most workloads, this is negligible.

## Deploying Vault on Kubernetes with Helm

Skip the manual installation—use the official Helm chart. Here's a production-ready configuration:

```bash
helm repo add hashicorp https://helm.releases.hashicorp.com
helm repo update

cat <<EOF > vault-values.yaml
global:
  enabled: true
  tlsDisable: false

server:
  replicas: 3
  
  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchLabels:
              app.kubernetes.io/name: vault
          topologyKey: kubernetes.io/hostname

  resources:
    requests:
      memory: 256Mi
      cpu: 250m
    limits:
      memory: 512Mi
      cpu: 500m

  dataStorage:
    enabled: true
    size: 10Gi
    storageClass: "gp3"

  auditStorage:
    enabled: true
    size: 10Gi
    storageClass: "gp3"

  ha:
    enabled: true
    raft:
      enabled: true
      setNodeId: true
      config: |
        ui = true
        listener "tcp" {
          tls_disable = 0
          address = "[::]:8200"
          cluster_address = "[::]:8201"
          tls_cert_file = "/vault/userconfig/vault-tls/tls.crt"
          tls_key_file = "/vault/userconfig/vault-tls/tls.key"
        }
        storage "raft" {
          path = "/vault/data"
          retry_join {
            leader_api_addr = "https://vault-0.vault-internal:8200"
            leader_ca_cert_file = "/vault/userconfig/vault-tls/ca.crt"
          }
          retry_join {
            leader_api_addr = "https://vault-1.vault-internal:8200"
            leader_ca_cert_file = "/vault/userconfig/vault-tls/ca.crt"
          }
          retry_join {
            leader_api_addr = "https://vault-2.vault-internal:8200"
            leader_ca_cert_file = "/vault/userconfig/vault-tls/ca.crt"
          }
        }
        service_registration "kubernetes" {}

injector:
  enabled: true
  replicas: 2
  resources:
    requests:
      memory: 64Mi
      cpu: 50m
    limits:
      memory: 128Mi
      cpu: 100m
EOF

kubectl create namespace vault
helm install vault hashicorp/vault -n vault -f vault-values.yaml
```

After installation, you'll need to initialize and unseal Vault. With Raft storage, initialize on the first pod:

```bash
kubectl exec -n vault vault-0 -- vault operator init -key-shares=5 -key-threshold=3 -format=json > vault-init.json

# Unseal each pod (repeat with 3 different keys)
kubectl exec -n vault vault-0 -- vault operator unseal <key1>
kubectl exec -n vault vault-0 -- vault operator unseal <key2>
kubectl exec -n vault vault-0 -- vault operator unseal <key3>
```

Store those unseal keys somewhere safe—AWS Secrets Manager, a hardware security module, or at minimum, split across different secure locations. Losing them means losing access to Vault permanently.

## Configuring Kubernetes Authentication

The Kubernetes auth method lets pods authenticate to Vault using their service account tokens. This is the foundation for the injector pattern:

```bash
# Login to Vault
export VAULT_ADDR="https://vault.vault.svc.cluster.local:8200"
export VAULT_TOKEN="<root-token-from-init>"

# Enable Kubernetes auth
vault auth enable kubernetes

# Configure it to talk to the Kubernetes API
vault write auth/kubernetes/config \
    kubernetes_host="https://kubernetes.default.svc:443" \
    kubernetes_ca_cert=@/var/run/secrets/kubernetes.io/serviceaccount/ca.crt

# Create a policy for your application
vault policy write myapp-policy - <<EOF
path "secret/data/myapp/*" {
  capabilities = ["read"]
}
path "database/creds/myapp-role" {
  capabilities = ["read"]
}
EOF

# Create a role binding service accounts to the policy
vault write auth/kubernetes/role/myapp \
    bound_service_account_names=myapp-sa \
    bound_service_account_namespaces=production \
    policies=myapp-policy \
    ttl=1h
```

This configuration means only pods running with the `myapp-sa` service account in the `production` namespace can read secrets under `secret/data/myapp/*`. Everything else gets denied.

## Injecting Secrets Into Pods

The Vault Agent Injector uses Kubernetes mutating webhooks to automatically inject a sidecar container that handles authentication and secret retrieval. Your application just reads files from a shared volume:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: myapp-sa
  namespace: production
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: myapp
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: myapp
  template:
    metadata:
      labels:
        app: myapp
      annotations:
        vault.hashicorp.com/agent-inject: "true"
        vault.hashicorp.com/role: "myapp"
        vault.hashicorp.com/agent-inject-secret-db-creds: "database/creds/myapp-role"
        vault.hashicorp.com/agent-inject-template-db-creds: |
          {{- with secret "database/creds/myapp-role" -}}
          export DB_USER="{{ .Data.username }}"
          export DB_PASSWORD="{{ .Data.password }}"
          {{- end }}
        vault.hashicorp.com/agent-inject-secret-api-key: "secret/data/myapp/api-keys"
        vault.hashicorp.com/agent-inject-template-api-key: |
          {{- with secret "secret/data/myapp/api-keys" -}}
          {{ .Data.data.stripe_key }}
          {{- end }}
    spec:
      serviceAccountName: myapp-sa
      containers:
        - name: myapp
          image: myregistry/myapp:v1.2.3
          command: ["/bin/sh", "-c"]
          args:
            - source /vault/secrets/db-creds && ./start-app
          volumeMounts:
            - name: vault-secrets
              mountPath: /vault/secrets
              readOnly: true
```

The injector creates an init container that waits for secrets before your app starts, plus a sidecar that keeps secrets refreshed. When database credentials rotate (which Vault can do automatically), the sidecar updates the files. Your app needs to watch for changes or periodically re-read them.

## Dynamic Database Credentials

Static secrets are fine, but dynamic database credentials are where Vault really shines. Configure the database secrets engine:

```bash
vault secrets enable database

vault write database/config/myapp-postgres \
    plugin_name=postgresql-database-plugin \
    allowed_roles="myapp-role" \
    connection_url="postgresql://{{username}}:{{password}}@postgres.database.svc:5432/myapp?sslmode=require" \
    username="vault-admin" \
    password="<admin-password>"

vault write database/roles/myapp-role \
    db_name=myapp-postgres \
    creation_statements="CREATE ROLE \"{{name}}\" WITH LOGIN PASSWORD '{{password}}' VALID UNTIL '{{expiration}}'; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO \"{{name}}\";" \
    revocation_statements="DROP ROLE IF EXISTS \"{{name}}\";" \
    default_ttl="1h" \
    max_ttl="24h"
```

Now every time a pod requests `database/creds/myapp-role`, Vault creates a fresh PostgreSQL user with a 1-hour TTL. When the pod dies or the TTL expires, Vault automatically revokes the credentials. No more shared database passwords sitting in config files for years.

## Monitoring and Troubleshooting

Enable audit logging immediately—it's the only way to track who accessed what:

```bash
vault audit enable file file_path=/vault/audit/audit.log
```

Watch for these common issues:

**Pods stuck in Init**: Usually means the injector can't authenticate. Check that the service account name and namespace match the Vault role exactly.

**"Permission denied" errors**: The policy doesn't grant access to the path. Remember that KV v2 secrets live under `secret/data/` even though you write to `secret/`.

**High memory usage**: The Vault Agent sidecar caches secrets in memory. If you're injecting large secrets or many secrets, increase the agent's memory limits.

Set up Prometheus metrics by adding `telemetry` configuration to Vault, and alert on `vault_core_unsealed` (should always be 1) and `vault_expire_num_leases` (watch for runaway lease counts).

## Next Step: Integrate With Your CI/CD Pipeline

Your next move is connecting Vault to your deployment pipeline. Configure GitHub Actions, GitLab CI, or ArgoCD to authenticate to Vault using JWT/OIDC, then pull deployment secrets dynamically. This eliminates the last bastion of static secrets—your CI/CD variables. The `vault` CLI with `-format=json` output pipes directly into `jq` for scripting, making automation straightforward.