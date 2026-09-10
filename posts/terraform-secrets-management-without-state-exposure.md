---
title: "Managing Secrets in Terraform Without Exposing State Files"
date: 2026-09-10
excerpt: "Stop leaking secrets in terraform.tfstate. Learn practical patterns using external data sources, SOPS, Vault, and ephemeral resources."
tags: ["terraform","secrets-management","infrastructure-as-code","hashicorp-vault","security"]
author: GeekOnCloud
draft: false
---

Every Terraform state file is a liability. Run `terraform show` on any production workspace and you'll find database passwords, API keys, and service account credentials sitting in plaintext JSON. AWS marks these as "sensitive" in the console, but Terraform dutifully records them in state—whether that's a local file, an S3 bucket, or Terraform Cloud. The moment your state leaks, every secret in your infrastructure is compromised.

I've seen this play out: a developer commits `.terraform` to git, an S3 bucket ACL gets misconfigured, a state file ends up in a Slack thread during debugging. The blast radius is always worse than expected because state files contain *everything*.

The good news: you can architect your Terraform workflows to never store secrets in state at all. Here's how.

## The Problem with Terraform's Secret Handling

Terraform treats secrets like any other resource attribute. When you create an `aws_secretsmanager_secret_version` or `random_password`, the actual secret value gets written to state:

```hcl
# This stores the password in plaintext in your state file
resource "random_password" "db" {
  length  = 32
  special = true
}

resource "aws_db_instance" "main" {
  identifier     = "production-db"
  engine         = "postgres"
  instance_class = "db.t3.medium"
  username       = "admin"
  password       = random_password.db.result  # Now in state twice
}
```

Pull up your state with `terraform state show random_password.db` and there's your password. The `sensitive = true` flag only hides values from CLI output—it does nothing for state storage.

Even with remote state encryption (S3 + KMS, for example), you're still trusting everyone with state access to handle secrets properly. That's a policy problem masquerading as a technical one.

## Pattern 1: Generate Secrets Outside Terraform Entirely

The cleanest approach: Terraform never touches the secret. You generate secrets in a secrets manager, then reference them at deploy time.

```bash
#!/bin/bash
# bootstrap-secrets.sh - Run once before terraform apply

# Generate and store database password
DB_PASSWORD=$(openssl rand -base64 32)
aws secretsmanager create-secret \
  --name "/prod/database/password" \
  --secret-string "$DB_PASSWORD" \
  --tags Key=ManagedBy,Value=bootstrap

# Generate API key
API_KEY=$(uuidgen)
aws secretsmanager create-secret \
  --name "/prod/api/key" \
  --secret-string "$API_KEY" \
  --tags Key=ManagedBy,Value=bootstrap
```

Then in Terraform, you reference the secret's ARN or path—never its value:

```hcl
data "aws_secretsmanager_secret" "db_password" {
  name = "/prod/database/password"
}

resource "aws_db_instance" "main" {
  identifier     = "production-db"
  engine         = "postgres"
  instance_class = "db.t3.medium"
  username       = "admin"
  
  # Reference the secret by ARN, let the application fetch it at runtime
  # Don't use data.aws_secretsmanager_secret_version - that pulls the value into state
}

# Pass the ARN to your application config
resource "aws_ssm_parameter" "db_password_arn" {
  name  = "/app/config/db-password-arn"
  type  = "String"
  value = data.aws_secretsmanager_secret.db_password.arn
}
```

Your application uses the SDK to fetch the secret at runtime. Terraform only knows the ARN exists—it never sees the password.

## Pattern 2: Use the `ephemeral` Block (Terraform 1.10+)

Terraform 1.10 introduced ephemeral resources specifically for this problem. Ephemeral values exist during the plan/apply cycle but never persist to state:

```hcl
ephemeral "aws_secretsmanager_secret_version" "db_password" {
  secret_id = aws_secretsmanager_secret.db.id
}

resource "aws_db_instance" "main" {
  identifier     = "production-db"
  engine         = "postgres"
  instance_class = "db.t3.medium"
  username       = "admin"
  password       = ephemeral.aws_secretsmanager_secret_version.db_password.secret_string
}
```

The password gets used during `apply` but the state file only records that an ephemeral reference was used—not the value itself. Subsequent plans fetch the current secret value fresh.

Limitation: the resource receiving the ephemeral value must support it. As of early 2025, provider support is still rolling out. Check the provider docs for your specific resources.

## Pattern 3: External Data Sources with One-Way References

For providers without ephemeral support, you can use external data sources that compute values without storing them:

```hcl
data "external" "db_password" {
  program = ["bash", "${path.module}/scripts/get-secret.sh"]
  
  query = {
    secret_name = "/prod/database/password"
  }
}
```

With a wrapper script:

```bash
#!/bin/bash
# scripts/get-secret.sh

# Read JSON input from stdin
INPUT=$(cat)
SECRET_NAME=$(echo "$INPUT" | jq -r '.secret_name')

# Fetch from secrets manager
SECRET_VALUE=$(aws secretsmanager get-secret-value \
  --secret-id "$SECRET_NAME" \
  --query SecretString \
  --output text)

# Output must be JSON
echo "{\"value\": \"$SECRET_VALUE\"}"
```

**Critical warning**: `data.external` results *do* get written to state unless you combine this with a write-only resource attribute. This pattern works best when you're passing secrets to a provisioner or local-exec that consumes the value but doesn't store it in a managed resource.

## Pattern 4: Write-Only Attributes for Rotation-Safe Secrets

Some providers now support write-only attributes that accept values but never read them back or store them in state. The AWS provider added this for several resources:

```hcl
resource "aws_db_instance" "main" {
  identifier     = "production-db"
  engine         = "postgres"
  instance_class = "db.t3.medium"
  username       = "admin"
  
  # manage_master_user_password lets AWS handle the secret entirely
  manage_master_user_password = true
}
```

With `manage_master_user_password = true`, RDS generates and stores the password in Secrets Manager automatically. Terraform never sees it. You get the secret ARN as an output:

```hcl
output "db_master_password_secret_arn" {
  value = aws_db_instance.main.master_user_secret[0].secret_arn
}
```

This is the gold standard when available: the cloud provider manages the entire secret lifecycle, Terraform manages infrastructure, and no credential crosses the boundary.

## Handling Existing Secrets in State

Already have secrets in state? You need to rotate them, not just remove them from state:

```bash
# 1. Identify secrets in state
terraform state list | xargs -I {} terraform state show {} 2>/dev/null | grep -E "(password|secret|key|token)" 

# 2. For each secret, rotate in the actual provider
# e.g., RDS password rotation via AWS CLI
aws rds modify-db-instance \
  --db-instance-identifier production-db \
  --master-user-password "$(openssl rand -base64 32)" \
  --apply-immediately

# 3. Refactor Terraform to use secretless patterns
# 4. Remove old resources from state (they're replaced, not destroyed)
terraform state rm random_password.db
```

Just removing a secret from state without rotating it leaves the original credential valid. Anyone who accessed historical state versions still has working credentials.

## State Encryption Is Not Enough

I hear this objection: "But my state is encrypted at rest with KMS!" 

Encryption protects against storage-level breaches. It does nothing when:
- Engineers run `terraform state pull` locally
- CI/CD logs capture state output during debugging
- Someone exports state for migration/analysis
- Your encryption key is compromised alongside state access

Encrypted state is necessary but not sufficient. The principle is simple: secrets that don't exist in state can't leak from state.

## Where to Go Next

Audit your current state right now. Run `terraform state pull | jq '.resources[].instances[].attributes | keys' | grep -iE "password|secret|key|token|credential"` and see what you're exposing. Then:

1. Enable `manage_master_user_password` (or equivalent) for any resource that supports it
2. For remaining secrets, migrate to the bootstrap-outside-Terraform pattern
3. Rotate every secret currently in state—assume it's compromised
4. Add a pre-commit hook that scans plans for sensitive values entering state

The goal isn't just compliance—it's reducing blast radius. When (not if) credentials leak, you want the answer to be "they got an ARN reference, not the actual secret."