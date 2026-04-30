#!/usr/bin/env node

/**
 * GeekOnCloud — Daily Blog Post Agent
 * 
 * Runs daily via Windows Task Scheduler.
 * 1. Picks a topic from the rotation list (or accepts one as CLI arg)
 * 2. Calls Claude to generate a full DevOps blog post
 * 3. Saves it as a Markdown file in /posts/
 * 4. Git commits + pushes → Vercel auto-redeploys
 *
 * Usage:
 *   node agent/daily-post.js
 *   node agent/daily-post.js "custom topic here"
 */

const https = require('https')
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') })

// ─── Config ────────────────────────────────────────────────────────────────

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
const LOG_FILE = path.join(__dirname, 'agent.log')
const POSTS_DIR = path.join(__dirname, '..', 'posts')

// Topic rotation — agent cycles through these, never repeating until all done
const TOPIC_POOL = [
  // Kubernetes
  'How to right-size Kubernetes resource requests and limits in production',
  'Kubernetes pod disruption budgets — preventing outages during deploys',
  'Building a multi-tenant Kubernetes platform with namespace isolation',
  'Kubernetes network policies — zero-trust networking for microservices',
  'Debugging OOMKilled pods in Kubernetes — a systematic approach',
  'Kubernetes HPA vs VPA vs KEDA — choosing the right autoscaler',
  'Speeding up Kubernetes cluster startup with image pre-pulling',
  'Running stateful workloads on Kubernetes with persistent volumes',

  // Terraform / IaC
  'Terraform remote state — best practices for teams',
  'Writing reusable Terraform modules with proper versioning',
  'Terraform drift detection and remediation in CI/CD',
  'Managing secrets in Terraform without storing them in state',
  'Terragrunt vs Terraform workspaces — when to use each',
  'Testing Terraform with Terratest — a practical guide',

  // CI/CD
  'GitHub Actions self-hosted runners on Kubernetes',
  'Building a secure supply chain with GitHub Actions and Sigstore',
  'GitLab CI vs GitHub Actions — a DevOps engineer comparison',
  'Caching strategies in CI/CD to cut pipeline time by 60%',
  'Feature flags with OpenFeature — decouple deploys from releases',

  // Cloud Cost / FinOps
  'AWS Spot Instances in production — patterns that actually work',
  'Rightsizing EC2 instances with AWS Compute Optimizer',
  'Cutting Kubernetes cloud costs with Karpenter node autoprovisioning',
  'FinOps fundamentals — tagging strategy for accurate cost attribution',
  'Reserved vs Savings Plans vs On-Demand — when each makes sense',

  // Observability
  'OpenTelemetry from zero to production — a complete setup guide',
  'Prometheus alerting rules that actually matter',
  'Distributed tracing with Tempo and Grafana',
  'Log aggregation with Loki — the Prometheus-native approach',
  'SLOs and error budgets — implementing them without the theory',

  // Platform Engineering
  'Building an Internal Developer Platform with Backstage',
  'Golden paths — reducing cognitive load for dev teams',
  'Port vs Backstage vs Cortex — IDP tools compared',
  'Self-service infrastructure with Crossplane',

  // Security / DevSecOps
  'Scanning container images in CI with Trivy and Grype',
  'Runtime security in Kubernetes with Falco',
  'Secrets management with HashiCorp Vault on Kubernetes',
  'mTLS everywhere — service mesh security with Istio',

  // GitOps
  'Argo CD vs Flux — choosing your GitOps engine in 2025',
  'Progressive delivery with Flagger and Argo Rollouts',
  'Multi-cluster GitOps with Argo CD ApplicationSets',

  // SRE
  'Chaos engineering with LitmusChaos on Kubernetes',
  'On-call runbooks that actually help during incidents',
  'Post-mortems that drive real change — a template and process',
  'MTTR vs MTBF — metrics that matter for reliability',
]

// ─── Logging ───────────────────────────────────────────────────────────────

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`
  console.log(line)
  fs.appendFileSync(LOG_FILE, line + '\n')
}

// ─── Topic Selection ───────────────────────────────────────────────────────

function pickTopic(customTopic) {
  if (customTopic) {
    log(`Using custom topic: ${customTopic}`)
    return customTopic
  }

  // Track used topics in a JSON file
  const usedFile = path.join(__dirname, 'used-topics.json')
  let used = []
  if (fs.existsSync(usedFile)) {
    try { used = JSON.parse(fs.readFileSync(usedFile, 'utf8')) } catch {}
  }

  // Filter out used topics; reset when all exhausted
  let remaining = TOPIC_POOL.filter(t => !used.includes(t))
  if (remaining.length === 0) {
    log('All topics used — resetting rotation')
    used = []
    remaining = [...TOPIC_POOL]
  }

  // Pick randomly from remaining
  const topic = remaining[Math.floor(Math.random() * remaining.length)]
  used.push(topic)
  fs.writeFileSync(usedFile, JSON.stringify(used, null, 2))
  log(`Selected topic: ${topic}`)
  return topic
}

// ─── Claude API Call ───────────────────────────────────────────────────────

function callClaude(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-opus-4-5',
      max_tokens: 4096,
      system: `You are an expert DevOps and Cloud Infrastructure engineer writing for geekoncloud.com. 
Write with practitioner-level depth, real-world examples, actual commands and configs. 
Voice: direct, no-fluff, opinionated. Like a senior engineer explaining to a peer.
Always include: working code blocks, real commands, concrete numbers/benchmarks where possible.
Never write generic advice — be specific, technical, and actionable.`,
      messages: [{ role: 'user', content: prompt }],
    })

    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body),
      },
    }

    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data)
          if (parsed.error) return reject(new Error(parsed.error.message))
          const text = parsed.content?.map(b => b.text || '').join('') || ''
          resolve(text)
        } catch (e) {
          reject(e)
        }
      })
    })

    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

// ─── Generate Post ─────────────────────────────────────────────────────────

async function generatePost(topic) {
  log('Calling Claude API to generate post...')

  // Step 1: Generate the full post content
  const postPrompt = `Write a complete, publication-ready technical blog post for geekoncloud.com about:

"${topic}"

Requirements:
- Write in Markdown
- Length: 1000-1400 words
- Structure: intro hook, 4-6 ## sections, practical conclusion
- Include at least 2 real code blocks (bash, yaml, or hcl)
- Be specific — real tool names, real flags, real configs
- No fluff, no "in conclusion" summaries — end with a concrete next step

Return ONLY the markdown content, starting directly with the first paragraph (no title, no frontmatter).`

  const content = await callClaude(postPrompt)

  // Step 2: Generate metadata
  const metaPrompt = `For a DevOps blog post about "${topic}", generate metadata.
Return ONLY valid JSON (no markdown, no explanation):
{
  "title": "SEO-optimised post title (under 65 chars)",
  "excerpt": "Meta description (under 155 chars, compelling)",
  "tags": ["tag1", "tag2", "tag3"],
  "slug": "url-friendly-slug-with-hyphens"
}`

  const metaRaw = await callClaude(metaPrompt)
  let meta
  try {
    const clean = metaRaw.replace(/```json|```/g, '').trim()
    meta = JSON.parse(clean)
  } catch {
    // Fallback metadata
    const slug = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60)
    meta = {
      title: topic.slice(0, 65),
      excerpt: `A practical guide to ${topic.toLowerCase()}.`,
      tags: ['DevOps', 'Cloud', 'Infrastructure'],
      slug,
    }
  }

  return { content, meta }
}

// ─── Save Post ─────────────────────────────────────────────────────────────

function savePost(meta, content) {
  if (!fs.existsSync(POSTS_DIR)) {
    fs.mkdirSync(POSTS_DIR, { recursive: true })
  }

  const date = new Date().toISOString().split('T')[0]
  const slug = meta.slug || meta.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60)
  const filename = `${slug}.md`
  const filepath = path.join(POSTS_DIR, filename)

  // Avoid overwriting — append date suffix if slug exists
  const finalPath = fs.existsSync(filepath)
    ? path.join(POSTS_DIR, `${slug}-${date}.md`)
    : filepath
  const finalSlug = path.basename(finalPath, '.md')

  const frontmatter = `---
title: "${meta.title}"
date: ${date}
excerpt: "${meta.excerpt}"
tags: ${JSON.stringify(meta.tags)}
author: GeekOnCloud
draft: false
---

`
  fs.writeFileSync(finalPath, frontmatter + content, 'utf8')
  log(`Saved post: ${finalPath}`)
  return { filepath: finalPath, slug: finalSlug, date }
}

// ─── Git Push ──────────────────────────────────────────────────────────────

function gitPush(filepath, title) {
  const rootDir = path.join(__dirname, '..')
  try {
    log('Running git add...')
    execSync(`git add "${filepath}"`, { cwd: rootDir, stdio: 'pipe' })

    log('Running git commit...')
    execSync(`git commit -m "post: ${title.slice(0, 60)}"`, { cwd: rootDir, stdio: 'pipe' })

    log('Running git push...')
    execSync('git push', { cwd: rootDir, stdio: 'pipe' })

    log('✓ Pushed to GitHub — Vercel will redeploy automatically')
    return true
  } catch (e) {
    log(`Git error: ${e.message}`)
    log('Post was saved locally but not pushed. Run "git push" manually.')
    return false
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  log('═══════════════════════════════════════')
  log('GeekOnCloud Daily Post Agent — starting')

  if (!ANTHROPIC_API_KEY) {
    log('ERROR: ANTHROPIC_API_KEY not set in .env.local')
    process.exit(1)
  }

  const customTopic = process.argv[2] || null
  const topic = pickTopic(customTopic)

  try {
    const { content, meta } = await generatePost(topic)
    log(`Generated post: "${meta.title}"`)

    const { filepath, slug } = savePost(meta, content)

    const pushed = gitPush(filepath, meta.title)

    log('═══════════════════════════════════════')
    log(`✓ Done! Post: "${meta.title}"`)
    log(`  Slug: ${slug}`)
    log(`  Pushed: ${pushed}`)
    log('═══════════════════════════════════════')
  } catch (err) {
    log(`ERROR: ${err.message}`)
    log(err.stack)
    process.exit(1)
  }
}

main()
