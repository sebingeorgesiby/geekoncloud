---
title: "Managing Secrets in Terraform Without Exposing State Files"
date: 2026-10-17
excerpt: "Stop leaking credentials in terraform.tfstate. Real patterns for HashiCorp Vault, AWS Secrets Manager, and SOPS integration with working examples."
tags: ["terraform","secrets-management","hashicorp-vault","aws-secrets-manager","infrastructure-security"]
author: GeekOnCloud
draft: false
---

Every Terraform state file is a ticking time bomb. Run `terraform show` on any production state, and you'll likely find database passwords, API keys, and service account credentials sitting there in plain text. Even if you're using remote state with encryption at rest, anyone with state access can read those secrets. And if you've ever accidentally committed `.tfstate` to git (we've all done it), you know the panic that follows.

The problem isn't Terraform—it's the fundamental architecture. Terraform needs to track resource attributes, and for many resources, those attributes include sensitive data. But there are practical patterns to minimize what ends up in state, and in some cases, eliminate secrets from state entirely.

## The State File Problem Is Worse Than You Think

Let's be concrete. Create an AWS RDS instance with Terraform:

```hcl
resource "aws_db_instance" "main" {
  identifier           = "prod-database"
  engine               = "postgres"
  engine_version       = "15.4"
  instance_class       = "db.t3.medium"
  allocated_storage    = 100
  db_name              = "appdb"
  username             = "admin"
  password             = var.db_password
  skip_final_snapshot  = true
}
```

Now check your state:

```bash
terraform state show aws_db_instance.main | grep password
```

There it is: `password = "your-super-secret-password"`. Encrypted S3 backend? Doesn't matter—anyone with `s3:GetObject` permissions reads it. Terraform Cloud? Team members with state access see it. This isn't a bug; it's how Terraform works.

The `sensitive = true` attribute only hides values from CLI output. It does nothing for state storage.

## Pattern 1: Generate Secrets Outside Terraform's View

The cleanest approach: never let Terraform see the secret at all. Use `random_password` to generate credentials, then immediately push them to a secrets manager—but here's the trick—use a provider that doesn't store the secret value in state.

```hcl
resource "random_password" "db_password" {
  length           = 32
  special          = true
  override_special = "!#$%&*()-_=+[]{}<>:?"
}

resource "aws_secretsmanager_secret" "db_credentials" {
  name = "prod/database/credentials"
}

resource "aws_secretsmanager_secret_version" "db_credentials" {
  secret_id = aws_secretsmanager_secret.db_credentials.id
  secret_string = jsonencode({
    username = "admin"
    password = random_password.db_password.result
  })
}

resource "aws_db_instance" "main" {
  identifier             = "prod-database"
  engine                 = "postgres"
  engine_version         = "15.4"
  instance_class         = "db.t3.medium"
  allocated_storage      = 100
  db_name                = "appdb"
  manage_master_user_password = true  # AWS manages the password
  master_user_secret_kms_key_id = aws_kms_key.db.arn
}
```

Wait—there's a catch. The `random_password` resource *does* store the password in state. So we've just moved the problem.

The real solution for RDS specifically: use `manage_master_user_password = true`. AWS generates, rotates, and stores the password in Secrets Manager automatically. Terraform never sees it. Your state contains only a reference to the secret ARN—not the password itself.

## Pattern 2: External Data Sources with Secrets Managers

For existing secrets or secrets managed outside Terraform, use data sources:

```hcl
data "aws_secretsmanager_secret_version" "api_key" {
  secret_id = "prod/external-api/key"
}

locals {
  api_key = jsondecode(data.aws_secretsmanager_secret_version.api_key.secret_string)["api_key"]
}

resource "aws_lambda_function" "processor" {
  function_name = "data-processor"
  runtime       = "python3.11"
  handler       = "main.handler"
  role          = aws_iam_role.lambda.arn
  filename      = "function.zip"

  environment {
    variables = {
      API_KEY_SECRET_ARN = data.aws_secretsmanager_secret_version.api_key.arn
    }
  }
}
```

Critical point: pass the *ARN*, not the secret value, to your Lambda. Let the Lambda fetch the secret at runtime using IAM permissions. Now your state contains only the ARN, and your Lambda code does:

```python
import boto3
import json

def get_secret(secret_arn):
    client = boto3.client('secretsmanager')
    response = client.get_secret_value(SecretId=secret_arn)
    return json.loads(response['SecretString'])
```

This pattern shifts secret retrieval from deploy-time to runtime. Your Terraform state stays clean, and you get automatic rotation support as a bonus.

## Pattern 3: The Vault Provider with Lease-Based Secrets

HashiCorp Vault changes the game entirely with dynamic secrets. Instead of storing long-lived credentials, Vault generates short-lived credentials on demand:

```hcl
provider "vault" {
  address = "https://vault.internal.company.com:8200"
}

data "vault_aws_access_credentials" "deploy" {
  backend = "aws"
  role    = "terraform-deploy"
  type    = "sts"
}

provider "aws" {
  access_key = data.vault_aws_access_credentials.deploy.access_key
  secret_key = data.vault_aws_access_credentials.deploy.secret_key
  token      = data.vault_aws_access_credentials.deploy.security_token
  region     = "us-east-1"
}
```

The credentials in state? They're STS tokens valid for 1 hour (configurable). By the time anyone could exfiltrate your state, the credentials are expired. Not perfect—a real-time attacker still wins—but dramatically reduces the window.

For database credentials, Vault's database secrets engine generates unique credentials per Terraform run:

```hcl
data "vault_database_credentials" "app" {
  backend = "database"
  role    = "app-readonly"
}

# Pass to application config, not directly to resources
resource "kubernetes_secret" "db_credentials" {
  metadata {
    name      = "db-credentials"
    namespace = "production"
  }

  data = {
    username = data.vault_database_credentials.app.username
    password = data.vault_database_credentials.app.password
  }
}
```

Yes, this puts the password in the Kubernetes secret—but now you're leveraging Kubernetes RBAC for access control, and Vault can rotate the credentials independently of Terraform runs.

## Pattern 4: SOPS and Mozilla's Approach

For teams not ready for Vault, SOPS (Secrets OPerationS) encrypts secrets in files that can be committed to git:

```bash
# Install sops
brew install sops

# Create encrypted secrets file
sops --encrypt --age age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw2zmrj2kg5sfn9aqmcac8p \
  secrets.yaml > secrets.enc.yaml
```

Then use the `sops` provider:

```hcl
terraform {
  required_providers {
    sops = {
      source  = "carlpett/sops"
      version = "~> 1.0"
    }
  }
}

data "sops_file" "secrets" {
  source_file = "secrets.enc.yaml"
}

# Use decrypted values
locals {
  api_key = data.sops_file.secrets.data["api_key"]
}
```

The catch: decrypted values still end up in state. SOPS solves the "secrets in git" problem, not the "secrets in state" problem. Use it as part of a defense-in-depth strategy, not as your only protection.

## State-Level Protections You Need Anyway

Regardless of which pattern you use, lock down state access:

```hcl
terraform {
  backend "s3" {
    bucket         = "company-terraform-state"
    key            = "prod/infrastructure.tfstate"
    region         = "us-east-1"
    encrypt        = true
    kms_key_id     = "arn:aws:kms:us-east-1:111111111111:key/your-key-id"
    dynamodb_table = "terraform-locks"
  }
}
```

Then restrict access:

```bash
# Minimal IAM policy for state access
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject"],
      "Resource": "arn:aws:s3:::company-terraform-state/prod/*",
      "Condition": {
        "StringEquals": {
          "aws:PrincipalTag/Team": "platform"
        }
      }
    }
  ]
}
```

Enable S3 access logging. Set up CloudTrail alerts for state bucket access. Rotate KMS keys annually. This doesn't prevent secrets from reaching state—it limits who can read them.

## The Pragmatic Path Forward

Start here: audit your current state files. Run `terraform state pull | grep -i -E "(password|secret|key|token)"` and see what's exposed. You'll probably find more than you expected.

Next, adopt `manage_master_user_password` for all RDS instances—it's the lowest-effort win. Then migrate to runtime secret fetching for application credentials, passing ARNs instead of values. If you're running anything at scale, Vault's dynamic secrets eliminate entire categories of risk.

Your next step: open your production state file right now and count the secrets. That number is your starting point—get it to zero.