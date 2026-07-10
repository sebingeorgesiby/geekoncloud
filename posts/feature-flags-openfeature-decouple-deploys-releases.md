---
title: "Feature Flags with OpenFeature: Decouple Deploys from Releases"
date: 2026-07-10
excerpt: "Stop coordinating release windows. Learn to implement OpenFeature for vendor-agnostic feature flags that let you deploy anytime and release when ready."
tags: ["feature-flags","openfeature","continuous-deployment","release-management","devops"]
author: GeekOnCloud
draft: false
---

The deploy happened at 2 AM. The feature flag was already in place. By morning, 5% of users were running the new checkout flow while everyone else saw the old one. No drama, no rollback, no hotfix. Just a config change in LaunchDarkly that took 200 milliseconds to propagate.

This is the difference between deploying code and releasing features. If you're still coupling these two concepts, you're creating unnecessary risk and slowing down your entire delivery pipeline.

OpenFeature is the open standard that lets you implement feature flags without vendor lock-in. Let's build a production-ready setup.

## Why OpenFeature Instead of Direct SDK Integration

Every feature flag vendor has their own SDK. LaunchDarkly has theirs, Split has theirs, Flagsmith has theirs. When you integrate directly, you're coupling your application code to a specific vendor's API.

OpenFeature provides a vendor-agnostic API that sits between your code and the flag provider. You write against the OpenFeature interface, then plug in whatever provider you want — or swap providers without touching application code.

The practical benefit: I've seen teams spend three months migrating from one flag vendor to another because the SDK was embedded in 400 different files. With OpenFeature, it's a configuration change.

The spec is maintained by the CNCF, which means it's not going anywhere. Current providers include LaunchDarkly, Split, Flagsmith, CloudBees, and several open-source options like flagd.

## Setting Up flagd as Your Feature Flag Backend

flagd is the reference implementation — a lightweight, open-source flag evaluation daemon that works perfectly for teams that don't need enterprise flag management features.

Deploy flagd alongside your application:

```yaml
# kubernetes/flagd-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: flagd
  namespace: feature-flags
spec:
  replicas: 2
  selector:
    matchLabels:
      app: flagd
  template:
    metadata:
      labels:
        app: flagd
    spec:
      containers:
        - name: flagd
          image: ghcr.io/open-feature/flagd:v0.7.1
          args:
            - start
            - --uri
            - file:/etc/flagd/flags.json
          ports:
            - containerPort: 8013
              name: grpc
            - containerPort: 8014
              name: metrics
          volumeMounts:
            - name: flag-config
              mountPath: /etc/flagd
          resources:
            requests:
              memory: "64Mi"
              cpu: "100m"
            limits:
              memory: "128Mi"
              cpu: "200m"
          livenessProbe:
            httpGet:
              path: /healthz
              port: 8014
            initialDelaySeconds: 5
            periodSeconds: 10
      volumes:
        - name: flag-config
          configMap:
            name: feature-flags
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: feature-flags
  namespace: feature-flags
data:
  flags.json: |
    {
      "flags": {
        "new-checkout-flow": {
          "state": "ENABLED",
          "variants": {
            "on": true,
            "off": false
          },
          "defaultVariant": "off",
          "targeting": {
            "if": [
              { "in": ["@beta.com", { "var": "email" }] },
              "on",
              { "fractional": [{ "var": "userId" }, ["on", 10], ["off", 90]] }
            ]
          }
        },
        "max-items-per-cart": {
          "state": "ENABLED",
          "variants": {
            "low": 10,
            "medium": 25,
            "high": 50
          },
          "defaultVariant": "medium"
        }
      }
    }
---
apiVersion: v1
kind: Service
metadata:
  name: flagd
  namespace: feature-flags
spec:
  selector:
    app: flagd
  ports:
    - name: grpc
      port: 8013
      targetPort: 8013
```

That targeting rule does two things: all users with `@beta.com` email domains get the new feature, plus 10% of everyone else based on a consistent hash of their userId. The hash ensures the same user always sees the same variant.

## Integrating OpenFeature in Your Application

Here's a Go service using OpenFeature with the flagd provider:

```go
package main

import (
    "context"
    "log"
    "net/http"
    "os"

    "github.com/open-feature/go-sdk/openfeature"
    flagd "github.com/open-feature/go-sdk-contrib/providers/flagd/pkg"
)

func main() {
    // Initialize the flagd provider
    provider := flagd.NewProvider(
        flagd.WithHost(os.Getenv("FLAGD_HOST")),
        flagd.WithPort(8013),
        flagd.WithTLS(false), // Enable in production with proper certs
    )

    // Set as the global provider
    openfeature.SetProvider(provider)
    
    // Wait for provider to be ready
    <-openfeature.ProviderReady()

    // Get a client for your service
    client := openfeature.NewClient("checkout-service")

    http.HandleFunc("/checkout", func(w http.ResponseWriter, r *http.Request) {
        ctx := r.Context()
        userID := r.Header.Get("X-User-ID")
        email := r.Header.Get("X-User-Email")

        // Evaluation context for targeting
        evalCtx := openfeature.NewEvaluationContext(
            userID,
            map[string]interface{}{
                "email":   email,
                "country": r.Header.Get("X-User-Country"),
            },
        )

        // Boolean flag evaluation
        useNewCheckout, err := client.BooleanValue(
            ctx,
            "new-checkout-flow",
            false, // default if evaluation fails
            evalCtx,
        )
        if err != nil {
            log.Printf("flag evaluation error: %v, using default", err)
        }

        if useNewCheckout {
            handleNewCheckout(w, r)
            return
        }
        handleLegacyCheckout(w, r)
    })

    http.HandleFunc("/cart", func(w http.ResponseWriter, r *http.Request) {
        ctx := r.Context()
        
        // Integer flag evaluation
        maxItems, err := client.IntValue(
            ctx,
            "max-items-per-cart",
            25, // default
            openfeature.EvaluationContext{},
        )
        if err != nil {
            log.Printf("flag evaluation error: %v", err)
        }

        handleCart(w, r, maxItems)
    })

    log.Fatal(http.ListenAndServe(":8080", nil))
}
```

The key pattern: always provide sensible defaults. Flag evaluation can fail for multiple reasons — network issues, flagd being unavailable, malformed flag configs. Your application should degrade gracefully.

## Progressive Rollouts and Kill Switches

The targeting rules in flagd use JSONLogic, which gives you serious flexibility. Here's a more complex rollout strategy:

```json
{
  "flags": {
    "new-payment-processor": {
      "state": "ENABLED",
      "variants": {
        "on": true,
        "off": false
      },
      "defaultVariant": "off",
      "targeting": {
        "if": [
          { "==": [{ "var": "env" }, "development"] },
          "on",
          {
            "if": [
              { "in": [{ "var": "userId" }, ["user-001", "user-002", "user-003"]] },
              "on",
              {
                "if": [
                  { "and": [
                    { "==": [{ "var": "country" }, "CA"] },
                    { ">=": [{ "var": "accountAge" }, 90] }
                  ]},
                  { "fractional": [{ "var": "userId" }, ["on", 25], ["off", 75]] },
                  "off"
                ]
              }
            ]
          }
        ]
      }
    }
  }
}
```

This rule implements a progressive rollout: all development traffic gets the feature, specific test users always get it, Canadian users with accounts older than 90 days get 25% exposure, everyone else gets the old behavior.

When something goes wrong, you flip one value and the feature is dead everywhere. No deploy, no CI pipeline, no container restart. Just change `"state": "ENABLED"` to `"state": "DISABLED"` and push the ConfigMap update.

## Observability and Flag Evaluation Metrics

You need to know which flags are evaluating, how often, and what variants users are seeing. flagd exposes Prometheus metrics on port 8014:

```yaml
# prometheus/scrape-config.yaml
- job_name: 'flagd'
  kubernetes_sd_configs:
    - role: pod
  relabel_configs:
    - source_labels: [__meta_kubernetes_pod_label_app]
      action: keep
      regex: flagd
    - source_labels: [__meta_kubernetes_pod_container_port_name]
      action: keep
      regex: metrics
```

Key metrics to alert on:
- `flagd_evaluation_total` — request rate per flag
- `flagd_evaluation_error_total` — evaluation failures
- `flagd_flag_state` — whether flags are enabled/disabled

Set up a Grafana dashboard that shows variant distribution over time. If you're rolling out to 10% of users, you should see roughly a 90/10 split in the metrics. If you don't, something's wrong with your targeting logic or evaluation context.

## Moving Beyond ConfigMaps

For production use at scale, you'll want flag configurations stored in Git with proper change management. flagd supports multiple sync sources:

- Kubernetes ConfigMaps (what we've shown)
- HTTP endpoints (point at a served JSON file)
- gRPC flag sync (for real-time updates from a management plane)
- File paths with fsnotify for hot reloading

The GitOps pattern works well: store flag configs in a repo, use Argo CD or Flux to sync changes to your cluster, and flagd picks them up within seconds.

For teams that outgrow flagd, OpenFeature providers exist for LaunchDarkly, Split, CloudBees, and others. Your application code stays identical — you're just swapping the provider initialization.

Start with a single non-critical feature behind a flag. Get comfortable with the evaluation context pattern and targeting rules. Once you've shipped a few features this way, you'll never want to go back to coupling deploys with releases. The 2 AM deploys become boring again, which is exactly what you want.