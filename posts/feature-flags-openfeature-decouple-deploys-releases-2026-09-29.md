---
title: "Feature Flags with OpenFeature: Decouple Deploys from Releases"
date: 2026-09-29
excerpt: "Stop conflating deployment with release. Learn to implement OpenFeature for progressive rollouts, kill switches, and trunk-based development."
tags: ["feature-flags","openfeature","devops","continuous-delivery","progressive-rollout"]
author: GeekOnCloud
draft: false
---

You're pushing code to production three times a day, but your PM wants to hold the new checkout flow until marketing signs off. Your options? Feature branches that rot for weeks, or a release train that moves at the speed of your slowest stakeholder.

There's a third option: ship the code now, turn it on later. Feature flags decouple deployment from release, letting you merge to main constantly while controlling who sees what through configuration instead of code branches.

But rolling your own flag system is a trap. You'll start with a simple `if/else` and a database table, then six months later you're maintaining a sprawling internal tool that nobody wants to own. OpenFeature solves this by providing a vendor-neutral standard for feature flagging—swap providers without rewriting your application code.

## Why OpenFeature Exists

Every feature flag vendor invented their own SDK. LaunchDarkly has theirs, Split has theirs, Unleash has theirs. If you pick wrong, or your vendor gets acquired, or pricing changes—you're stuck rewriting flag evaluation logic across your entire codebase.

OpenFeature is a CNCF project that defines a standard API for feature flag evaluation. Think of it like OpenTelemetry, but for flags. You write your code against the OpenFeature SDK, plug in a provider for your backend of choice, and swap implementations without touching application logic.

The spec covers the basics you'd expect: boolean flags, string/number/object variants, evaluation context (user attributes for targeting), and hooks for logging and metrics. But the killer feature is portability. You can start with a simple file-based provider in development, use Flagsmith in staging, and run LaunchDarkly in production—same application code everywhere.

## Setting Up OpenFeature with flagd

Let's build a real example. We'll use `flagd`, the open-source OpenFeature-compatible flag evaluation daemon. It runs as a sidecar or standalone service and reads flag definitions from files, HTTP endpoints, or Kubernetes ConfigMaps.

First, run flagd locally with Docker:

```bash
# Create a flags configuration file
cat > flags.json << 'EOF'
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
          { "in": ["@beta.example.com", { "var": "email" }] },
          "on",
          "off"
        ]
      }
    },
    "max-items-per-cart": {
      "state": "ENABLED",
      "variants": {
        "low": 10,
        "standard": 50,
        "unlimited": 9999
      },
      "defaultVariant": "standard",
      "targeting": {
        "if": [
          { "==": [{ "var": "tier" }, "enterprise"] },
          "unlimited",
          { "if": [
            { "==": [{ "var": "tier" }, "free"] },
            "low",
            "standard"
          ]}
        ]
      }
    }
  }
}
EOF

# Run flagd
docker run -p 8013:8013 -v $(pwd)/flags.json:/flags.json \
  ghcr.io/open-feature/flagd:latest start \
  --uri file:/flags.json
```

This gives you a flag server with targeting rules. The `new-checkout-flow` flag returns `true` for users with beta email domains. The `max-items-per-cart` flag returns different limits based on customer tier.

Now integrate it into a Node.js application:

```javascript
import { OpenFeature } from '@openfeature/server-sdk';
import { FlagdProvider } from '@openfeature/flagd-provider';

// Initialize the provider
await OpenFeature.setProviderAndWait(new FlagdProvider({
  host: 'localhost',
  port: 8013,
}));

const client = OpenFeature.getClient();

// Set evaluation context (user attributes)
const context = {
  targetingKey: 'user-12345',
  email: 'alice@beta.example.com',
  tier: 'enterprise',
};

// Evaluate flags with context
const showNewCheckout = await client.getBooleanValue('new-checkout-flow', false, context);
const maxItems = await client.getNumberValue('max-items-per-cart', 50, context);

console.log(`New checkout: ${showNewCheckout}`); // true (beta email)
console.log(`Max items: ${maxItems}`);           // 9999 (enterprise tier)
```

Notice the pattern: you always provide a default value. If flagd is down, the SDK falls back gracefully. No flag service outage should crash your application.

## Deploying flagd on Kubernetes

For production, you'll want flagd running as a deployment with flags stored in ConfigMaps (or synced from git). Here's a complete setup:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: feature-flags
  namespace: flags
data:
  flags.json: |
    {
      "flags": {
        "new-checkout-flow": {
          "state": "ENABLED",
          "variants": { "on": true, "off": false },
          "defaultVariant": "off"
        }
      }
    }
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: flagd
  namespace: flags
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
        image: ghcr.io/open-feature/flagd:v0.10.0
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
        - name: flags
          mountPath: /etc/flagd
        resources:
          requests:
            cpu: 50m
            memory: 64Mi
          limits:
            cpu: 200m
            memory: 128Mi
        livenessProbe:
          httpGet:
            path: /healthz
            port: 8014
          initialDelaySeconds: 5
        readinessProbe:
          httpGet:
            path: /readyz
            port: 8014
      volumes:
      - name: flags
        configMap:
          name: feature-flags
---
apiVersion: v1
kind: Service
metadata:
  name: flagd
  namespace: flags
spec:
  selector:
    app: flagd
  ports:
  - port: 8013
    name: grpc
```

The ConfigMap approach means changing flags is a `kubectl apply` away—no application redeploy needed. For GitOps workflows, your flags live in version control alongside your infrastructure definitions.

## Progressive Rollouts and Kill Switches

Raw boolean flags are table stakes. The real power comes from percentage-based rollouts and instant kill switches.

flagd supports fractional targeting out of the box. Here's a flag that rolls out to 10% of users, identified by their targeting key:

```json
{
  "flags": {
    "new-recommendation-engine": {
      "state": "ENABLED",
      "variants": { "on": true, "off": false },
      "defaultVariant": "off",
      "targeting": {
        "fractional": [
          { "var": "targetingKey" },
          ["on", 10],
          ["off", 90]
        ]
      }
    }
  }
}
```

The `targetingKey` ensures consistent bucketing—user `abc123` always gets the same variant. Bump that 10 to 25, then 50, then 100 as you gain confidence.

For kill switches, the `state` field is your friend. Set it to `DISABLED` and the flag immediately returns the default variant, regardless of targeting rules:

```json
{
  "state": "DISABLED",
  ...
}
```

When your new recommendation engine starts spiking latency, one ConfigMap change and a `kubectl apply` turns it off globally. No code push, no CI pipeline, no waiting for deploys.

## Observability: Flags as Dimensions

Feature flags without observability is flying blind. You need to know which variant was evaluated for every request so you can correlate performance and errors with flag states.

OpenFeature has a hooks system that fires before and after evaluation. Use it to emit metrics and attach flag values to your traces:

```javascript
import { OpenFeature, Hook } from '@openfeature/server-sdk';

const loggingHook: Hook = {
  after: (hookContext, evaluationDetails) => {
    console.log({
      flag: hookContext.flagKey,
      variant: evaluationDetails.variant,
      reason: evaluationDetails.reason,
      user: hookContext.context.targetingKey,
    });
    
    // Emit to your metrics system
    metrics.increment('feature_flag_evaluation', {
      flag: hookContext.flagKey,
      variant: evaluationDetails.variant,
    });
  },
  error: (hookContext, error) => {
    metrics.increment('feature_flag_error', {
      flag: hookContext.flagKey,
      error: error.message,
    });
  },
};

OpenFeature.addHooks(loggingHook);
```

In Grafana, you can now query: "What's the p99 latency for requests where `new-checkout-flow=on` versus `off`?" That's how you catch regressions before rolling out to 100%.

## Getting Off the Ground

Here's your concrete next step: pick one upcoming feature that has stakeholder timing concerns. Instead of holding the PR, ship it behind a flag. Use flagd locally, store flags in a ConfigMap if you're on Kubernetes, or a JSON file synced via S3 if you're not.

Start simple—boolean flags, no targeting rules. Get comfortable with the pattern of deploying disabled features. Then add percentage rollouts. Then add user targeting.

The OpenFeature SDKs exist for Go, Java, Python, JavaScript, .NET, PHP, and Ruby. flagd is around 15MB and uses about 30MB of memory under typical load. There's no excuse not to run it.

You can always swap to LaunchDarkly or Split later if you need their UI and collaboration features—that's the whole point of OpenFeature. But start with the free, open-source stack. You'll be surprised how far it takes you.