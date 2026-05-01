---
title: "Terraform at scale â€” structuring modules for 50+ environments"
date: 2025-04-10
excerpt: "Monolithic Terraform state files are a footgun. Here's the module structure and workspace strategy we use to manage 50+ environments without losing our minds."
tags: ["Terraform", "Platform Engineering", "Cloud Cost"]
author: GeekOnCloud
draft: false
---

## The problem with flat Terraform

Most teams start Terraform with a single `main.tf` and a single state file. This works until it doesn't â€” usually around the 5th environment or 20th engineer.

The problems compound quickly:

- State lock contention during concurrent applies
- A broken dev environment that can block a production deploy
- No clear ownership boundary between teams
- Drift between environments because of manual overrides

## The module structure that scales

After managing infrastructure for 3+ organisations, this is the layout that consistently works:

```
infra/
â”œâ”€â”€ modules/
â”‚   â”œâ”€â”€ networking/       # VPC, subnets, security groups
â”‚   â”œâ”€â”€ eks-cluster/      # EKS + node groups
â”‚   â”œâ”€â”€ rds/              # RDS with parameter groups
â”‚   â””â”€â”€ observability/    # Prometheus, Grafana, alerting
â”œâ”€â”€ environments/
â”‚   â”œâ”€â”€ dev/
â”‚   â”‚   â”œâ”€â”€ main.tf
â”‚   â”‚   â”œâ”€â”€ variables.tf
â”‚   â”‚   â””â”€â”€ terraform.tfvars
â”‚   â”œâ”€â”€ staging/
â”‚   â””â”€â”€ production/
â””â”€â”€ shared/
    â”œâ”€â”€ dns/
    â””â”€â”€ ecr/
```

**Key principle**: modules own *what*, environments own *where and how much*.

## Separate state per environment

Each environment directory is its own Terraform root with isolated state. Never share state between environments.

```hcl
# environments/production/main.tf
terraform {
  backend "s3" {
    bucket         = "myorg-terraform-state"
    key            = "production/terraform.tfstate"
    region         = "eu-west-1"
    encrypt        = true
    dynamodb_table = "terraform-locks"
  }
}

module "eks" {
  source       = "../../modules/eks-cluster"
  cluster_name = "prod-eu"
  node_count   = var.node_count
  instance_types = ["m6i.xlarge", "m6i.2xlarge"]
}
```

## Variable hierarchy

Use `terraform.tfvars` for environment-specific values and module defaults for sensible base configuration:

```hcl
# modules/eks-cluster/variables.tf
variable "node_count" {
  description = "Desired node count"
  type        = number
  default     = 3
}

variable "instance_types" {
  description = "EC2 instance types (spot-friendly list)"
  type        = list(string)
  default     = ["m6i.large"]
}
```

## Locking module versions

Always pin module versions. Floating references like `source = "../../modules/eks"` without a version constraint mean a module change can affect all environments simultaneously.

For public registry modules, use exact versions:

```hcl
module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "5.8.1"  # never use ~> in production
}
```

## CI/CD pipeline

We run Terraform through GitHub Actions with environment protection rules:

1. `terraform plan` runs on every PR â€” output posted as a comment
2. `terraform apply` requires a manual approval step for staging/production
3. `atlantis` or `env0` for teams that want automatic PR-driven workflows

## Cost attribution

Tag everything at the module level:

```hcl
locals {
  common_tags = {
    Environment = var.environment
    Team        = var.team
    ManagedBy   = "terraform"
    CostCenter  = var.cost_center
  }
}
```

This makes AWS Cost Explorer and FinOps tooling actually useful.

## Conclusion

The upfront investment in a proper module structure pays back within weeks. Separate state per environment, versioned modules, and clear ownership boundaries are the foundation. Everything else â€” drift detection, cost attribution, automated plans â€” builds on top.

---

## Tools & Resources

*Tools relevant to this post. Some links are affiliate links — they cost you nothing and help keep geekoncloud.com running.*

- **[Datadog](https://www.datadoghq.com/?utm_source=geekoncloud)** — cloud monitoring and observability platform
- **[Snyk](https://snyk.io/?utm_source=geekoncloud)** — developer-first security and vulnerability scanning
- **[Terraform Cloud](https://app.terraform.io/signup?utm_source=geekoncloud)** — managed Terraform with remote state and team collaboration
