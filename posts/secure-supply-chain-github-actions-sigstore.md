---
title: "Secure Supply Chain with GitHub Actions and Sigstore"
date: 2026-07-22
excerpt: "Implement container signing, SBOM generation, and provenance attestation using Sigstore cosign and GitHub Actions. Production-ready workflows included."
tags: ["github-actions","sigstore","supply-chain-security","container-signing","devsecops"]
author: GeekOnCloud
draft: false
---

Every time you run `npm install` or `docker pull`, you're trusting hundreds of strangers. That base image? Built by someone you've never met. Those GitHub Actions? Written by maintainers who might have their credentials compromised tomorrow. Supply chain attacks aren't theoretical—SolarWinds, Codecov, and the ua-parser-js npm incident proved that. The question isn't whether to secure your supply chain, it's how to do it without grinding your release velocity to a halt.

Sigstore changes the equation. It's cryptographic signing without the key management nightmare, and GitHub Actions has native integration that makes this surprisingly painless. Let's build a real pipeline that signs containers, verifies dependencies, and creates an auditable chain of trust.

## Understanding the Sigstore Stack

Sigstore isn't a single tool—it's three components working together:

**Cosign** handles container image signing and verification. Unlike traditional GPG-based signing where you manage long-lived keys, Cosign uses ephemeral keys tied to OIDC identities. Your GitHub Actions workflow gets a short-lived certificate from Fulcio (Sigstore's CA), signs the artifact, and the signature is recorded in Rekor (an immutable transparency log). The private key never touches disk and expires in minutes.

**Fulcio** is the certificate authority. When your GitHub Actions workflow requests a signing certificate, Fulcio verifies the OIDC token from GitHub, confirms your identity (the repository, workflow, and commit), and issues a certificate that embeds this identity information.

**Rekor** is the transparency log. Every signature gets recorded with a timestamp, creating an auditable trail. If someone tries to sign a malicious image pretending to be your release, either they won't have valid OIDC credentials, or the timestamp won't match your release window.

The key insight: you're not managing keys anymore. You're proving identity through your existing GitHub authentication, and Sigstore handles the cryptographic machinery.

## Signing Container Images in GitHub Actions

Here's a production workflow that builds, signs, and pushes a container image:

```yaml
name: Build and Sign Container

on:
  push:
    tags: ['v*']

permissions:
  contents: read
  packages: write
  id-token: write  # Required for Sigstore OIDC

jobs:
  build-sign-push:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Install Cosign
        uses: sigstore/cosign-installer@v3.4.0
        
      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3
        
      - name: Login to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
          
      - name: Extract metadata
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ghcr.io/${{ github.repository }}
          tags: |
            type=semver,pattern={{version}}
            type=sha,prefix=
            
      - name: Build and push
        id: build
        uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          
      - name: Sign the image
        env:
          DIGEST: ${{ steps.build.outputs.digest }}
          TAGS: ${{ steps.meta.outputs.tags }}
        run: |
          images=""
          for tag in ${TAGS}; do
            images+="${tag}@${DIGEST} "
          done
          cosign sign --yes ${images}
```

The `id-token: write` permission is critical—it allows the workflow to request an OIDC token from GitHub. The `--yes` flag on `cosign sign` enables keyless signing mode, where Cosign automatically fetches a certificate from Fulcio using the GitHub OIDC token.

After this runs, your image has a signature stored in the registry alongside it (as an OCI artifact), and a record in the public Rekor transparency log.

## Verifying Images Before Deployment

Signing is useless without verification. Here's how to enforce signature checks in your deployment pipeline:

```yaml
name: Deploy to Production

on:
  workflow_dispatch:
    inputs:
      image_tag:
        required: true
        description: 'Image tag to deploy'

jobs:
  verify-and-deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Install Cosign
        uses: sigstore/cosign-installer@v3.4.0
        
      - name: Verify image signature
        env:
          IMAGE: ghcr.io/${{ github.repository }}:${{ inputs.image_tag }}
        run: |
          cosign verify \
            --certificate-identity-regexp="https://github.com/${{ github.repository }}/.github/workflows/.*" \
            --certificate-oidc-issuer="https://token.actions.githubusercontent.com" \
            ${IMAGE}
            
      - name: Deploy to Kubernetes
        if: success()
        run: |
          kubectl set image deployment/myapp \
            myapp=ghcr.io/${{ github.repository }}:${{ inputs.image_tag }}
```

The verification step checks two things: that the image was signed by a certificate issued by GitHub's OIDC provider, and that the signing workflow came from your repository. If either check fails, the deployment stops.

For Kubernetes-native enforcement, deploy Sigstore's policy-controller (part of the sigstore/policy-controller project). It acts as an admission webhook that rejects any pod using an unsigned or incorrectly-signed image:

```bash
helm install policy-controller sigstore/policy-controller \
  --namespace sigstore-system \
  --create-namespace \
  --set webhook.failOpen=false
```

Then apply a ClusterImagePolicy:

```yaml
apiVersion: policy.sigstore.dev/v1beta1
kind: ClusterImagePolicy
metadata:
  name: require-signed-images
spec:
  images:
    - glob: "ghcr.io/your-org/**"
  authorities:
    - keyless:
        identities:
          - issuer: https://token.actions.githubusercontent.com
            subjectRegExp: https://github.com/your-org/.*/.github/workflows/.*
```

Now any attempt to deploy an unsigned image from your org's registry gets rejected at admission time.

## Generating and Attesting SBOMs

Signatures prove who built the image, but SBOMs (Software Bill of Materials) prove what's inside. Combine both:

```yaml
- name: Generate SBOM
  uses: anchore/sbom-action@v0
  with:
    image: ghcr.io/${{ github.repository }}@${{ steps.build.outputs.digest }}
    format: spdx-json
    output-file: sbom.spdx.json
    
- name: Attest SBOM to image
  run: |
    cosign attest --yes \
      --predicate sbom.spdx.json \
      --type spdxjson \
      ghcr.io/${{ github.repository }}@${{ steps.build.outputs.digest }}
```

The attestation is cryptographically bound to the image digest. Anyone pulling your image can verify the SBOM came from your build pipeline and hasn't been tampered with:

```bash
cosign verify-attestation \
  --type spdxjson \
  --certificate-identity-regexp="https://github.com/your-org/.*" \
  --certificate-oidc-issuer="https://token.actions.githubusercontent.com" \
  ghcr.io/your-org/your-app:v1.2.3 | jq -r '.payload' | base64 -d
```

## Securing Third-Party Actions

Your supply chain includes the Actions you use. Pin everything to full commit SHAs, not tags:

```yaml
# Bad - tags can be moved
- uses: actions/checkout@v4

# Good - immutable reference  
- uses: actions/checkout@b4ffde65f46336ab88eb53be808477a3936bae11
```

Use GitHub's dependency graph and Dependabot to track Action versions. For critical workflows, vendor the Actions into your repository or use a private Actions registry with signature verification.

The `actions/dependency-review-action` can block PRs that introduce dependencies with known vulnerabilities:

```yaml
- name: Dependency Review
  uses: actions/dependency-review-action@v4
  with:
    fail-on-severity: high
    deny-licenses: GPL-3.0, AGPL-3.0
```

## What to Implement Monday Morning

Start with container signing—it's the highest-impact, lowest-effort change. Add the Cosign installer and sign step to your existing build workflow. Takes 15 minutes, and you immediately have cryptographic proof of every release.

Next, add verification to your deployment pipeline. Even if you don't enforce it initially, log verification failures to understand your current state.

Then deploy the policy-controller to a staging cluster with `failOpen=true`. Let it run for a week, review the logs, then flip to enforcement.

The transparency log at rekor.sigstore.dev is public and searchable. Run `rekor-cli search --email your-ci@github.com` to see your signing history. If you ever need to audit what was released and when, it's all there, immutable and timestamped.