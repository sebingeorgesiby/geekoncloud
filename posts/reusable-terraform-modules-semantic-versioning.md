---
title: "Writing Reusable Terraform Modules with Semantic Versioning"
date: 2026-05-01
excerpt: "Build production-grade Terraform modules with proper versioning, input validation, and registry publishing. Includes real module structure and CI/CD pipeline."
tags: ["terraform","infrastructure-as-code","devops","modules","versioning"]
author: GeekOnCloud
draft: false
---

Every Terraform project starts simple. A few resources, maybe a VPC, some EC2 instances. Then reality hits: you need the same infrastructure in staging, production, and three other AWS accounts. Copy-paste begins. Six months later, you're maintaining five slightly different versions of the same code, and nobody remembers which one has the security fix.

Reusable Terraform modules solve this—but only if you build them right. Most "reusable" modules I've seen in the wild are anything but. They're either so rigid they require forking for any customization, or so flexible they're impossible to understand. Let's fix that.

## The Anatomy of a Production-Grade Module

A proper Terraform module isn't just a directory with some `.tf` files. It's a contract. Here's the structure I use for every module that leaves my machine:

```
terraform-aws-vpc/
├── main.tf           # Core resource definitions
├── variables.tf      # Input variables with descriptions and validation
├── outputs.tf        # Exposed values for consumers
├── versions.tf       # Provider and Terraform version constraints
├── README.md         # Usage examples and variable documentation
├── examples/
│   ├── simple/
│   │   └── main.tf
│   └── complete/
│       └── main.tf
└── tests/
    └── vpc_test.go   # Terratest or similar
```

The `versions.tf` file is where most people screw up first:

```hcl
terraform {
  required_version = ">= 1.5.0, < 2.0.0"
  
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0.0, < 6.0.0"
    }
  }
}
```

Notice the version constraints. `>= 1.5.0, < 2.0.0` isn't paranoia—it's acknowledging that Terraform 2.0 will probably break something. Pin your floor, cap your ceiling. The same logic applies to providers. AWS provider 5.x introduced breaking changes from 4.x. Your module consumers shouldn't discover this at 2 AM during a production deployment.

## Designing Variables That Don't Suck

The difference between a module that gets adopted and one that gets forked is variable design. Here's a real example from a VPC module:

```hcl
variable "vpc_cidr" {
  description = "CIDR block for the VPC. Must be /16 to /24."
  type        = string
  
  validation {
    condition     = can(cidrhost(var.vpc_cidr, 0)) && tonumber(split("/", var.vpc_cidr)[1]) >= 16 && tonumber(split("/", var.vpc_cidr)[1]) <= 24
    error_message = "VPC CIDR must be a valid IPv4 CIDR between /16 and /24."
  }
}

variable "availability_zones" {
  description = "List of AZs to deploy subnets into. Defaults to first 3 AZs in region."
  type        = list(string)
  default     = null
}

variable "enable_nat_gateway" {
  description = "Deploy NAT Gateway for private subnet internet access. Costs ~$32/month per AZ."
  type        = bool
  default     = true
}

variable "tags" {
  description = "Tags to apply to all resources. Module adds Name tag automatically."
  type        = map(string)
  default     = {}
}
```

Three things happening here that matter:

1. **Validation blocks** catch garbage input before it creates garbage infrastructure. That CIDR validation prevents someone from passing `10.0.0.0/8` and wondering why they can't create subnets.

2. **Cost callouts in descriptions.** That NAT Gateway note? It's saved multiple teams from surprise bills. Documentation is free; debugging unexpected charges isn't.

3. **Sensible defaults with escape hatches.** `availability_zones = null` means "figure it out" inside the module using `data.aws_availability_zones.available`, but you can override it when needed.

## Semantic Versioning: Your Module's API Contract

Your module versions aren't arbitrary numbers—they're promises. Adopt SemVer properly:

- **MAJOR (1.0.0 → 2.0.0):** Breaking changes. Renamed variables, removed outputs, changed resource behaviors that require state manipulation.
- **MINOR (1.0.0 → 1.1.0):** New features, new optional variables with defaults, new outputs. Fully backward compatible.
- **PATCH (1.0.0 → 1.0.1):** Bug fixes, documentation updates, internal refactoring with no interface changes.

Tag your releases in Git. Every. Single. One:

```bash
git tag -a v1.2.0 -m "Add support for IPv6 CIDR blocks"
git push origin v1.2.0
```

Then in your module consumers:

```hcl
module "vpc" {
  source  = "git::https://github.com/yourorg/terraform-aws-vpc.git?ref=v1.2.0"
  # or if using Terraform Registry
  source  = "yourorg/vpc/aws"
  version = "~> 1.2.0"
}
```

The `~>` operator is your friend. `~> 1.2.0` means "1.2.0 or higher, but less than 1.3.0." It accepts patches but blocks minors. For production, I typically use `~> 1.2` which allows `1.2.x` and `1.3.x` but blocks `2.0.0`.

## Publishing and Distribution Strategies

You have three realistic options for module distribution:

**Git repositories** work for most teams. Reference modules directly via HTTPS or SSH:

```hcl
module "vpc" {
  source = "git::ssh://git@github.com/yourorg/terraform-aws-vpc.git?ref=v1.2.0"
}
```

Pro: Simple, works with existing Git infrastructure. Con: No built-in module registry features, manual version discovery.

**Terraform Cloud/Enterprise Private Registry** is the enterprise play. Upload modules, get a nice UI, automatic documentation generation, and version browsing. Costs money but integrates cleanly with Terraform Cloud workspaces.

**Self-hosted registry** using something like Terrareg or the Terraform Registry Protocol is possible but rarely worth the operational overhead unless you're at serious scale (50+ modules, multiple teams).

For most organizations under 500 engineers, Git repos with good tagging practices and a `CHANGELOG.md` file work fine. Don't over-engineer distribution until module discovery actually becomes a bottleneck.

## Testing Modules Before They Break Production

Untested modules are liabilities. At minimum, every module needs:

1. **Static analysis** via `terraform validate` and `tflint`. Run these in CI on every PR.

2. **Example deployments** that actually apply. Your `examples/simple/` directory should be deployable with `terraform apply -auto-approve` in a sandbox account.

3. **Integration tests** using Terratest (Go) or pytest-terraform (Python). Here's a minimal Terratest example:

```go
package test

import (
    "testing"
    "github.com/gruntwork-io/terratest/modules/terraform"
    "github.com/stretchr/testify/assert"
)

func TestVpcModule(t *testing.T) {
    terraformOptions := &terraform.Options{
        TerraformDir: "../examples/simple",
        Vars: map[string]interface{}{
            "vpc_cidr": "10.99.0.0/16",
        },
    }

    defer terraform.Destroy(t, terraformOptions)
    terraform.InitAndApply(t, terraformOptions)

    vpcId := terraform.Output(t, terraformOptions, "vpc_id")
    assert.Regexp(t, `^vpc-[a-z0-9]+$`, vpcId)
}
```

Run this in CI against a dedicated AWS account. Yes, it costs money to spin up real infrastructure. It costs more money to debug broken modules in production.

## Maintaining Modules Without Losing Your Mind

Modules are products. They need maintenance. Set up these guardrails:

- **Dependabot or Renovate** for provider version updates. AWS provider releases weekly; you should know when new versions drop.
- **CHANGELOG.md** following Keep a Changelog format. Future you will thank present you.
- **Breaking change policy.** Document it. I use: "Breaking changes require 30 days deprecation notice in CHANGELOG, minimum one minor version with deprecation warnings before major bump."
- **CODEOWNERS file** so PRs to module repos ping the right people.

The goal is making modules boring. Boring infrastructure is reliable infrastructure.

---

Your next step: pick one piece of copy-pasted Terraform in your codebase and extract it into a versioned module. Start with something small—a security group pattern, an S3 bucket with standard encryption settings. Get the structure right on something low-risk before tackling your VPC or EKS setup. Ship it with a v0.1.0 tag, wire up basic CI, and iterate from there.

---

## Tools & Resources

*Tools relevant to this post. Some links are affiliate links — they cost you nothing and help keep geekoncloud.com running.*

- **[Datadog](https://www.datadoghq.com/?utm_source=geekoncloud)** — cloud monitoring and observability platform
- **[Snyk](https://snyk.io/?utm_source=geekoncloud)** — developer-first security and vulnerability scanning
- **[Terraform Cloud](https://app.terraform.io/signup?utm_source=geekoncloud)** — managed Terraform with remote state and team collaboration
