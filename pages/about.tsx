import Layout from '../components/Layout'
import Link from 'next/link'

export default function About() {
  return (
    <Layout title="About" description="About GeekOnCloud — a DevOps and Infrastructure engineering blog.">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-12">
        <div className="flex items-center gap-5 mb-10">
          <div className="flex items-center justify-center w-16 h-16 rounded-2xl bg-ink-900 text-white font-display text-2xl font-bold">G</div>
          <div>
            <h1 className="font-display text-3xl font-bold text-ink-900">GeekOnCloud</h1>
            <p className="text-ink-400 text-sm mt-1">DevOps · Cloud · Infrastructure</p>
          </div>
        </div>
        <div className="prose prose-zinc max-w-none">
          <p>
            GeekOnCloud is a technical blog for engineers who live in the terminal, wrestle with Kubernetes manifests,
            and care deeply about building reliable, cost-efficient cloud infrastructure.
          </p>
          <p>
            I write practical, no-fluff guides on the tools and practices that make modern infrastructure teams ship faster —
            from Terraform modules and GitOps workflows to platform engineering patterns and cloud FinOps.
          </p>
          <h2>What you&apos;ll find here</h2>
          <ul>
            <li>Step-by-step tutorials with real configs and commands</li>
            <li>Deep dives into Kubernetes, Terraform, CI/CD, and observability</li>
            <li>Cloud cost optimisation strategies and FinOps practices</li>
            <li>Platform engineering patterns and internal developer platform design</li>
            <li>SRE and reliability engineering practices</li>
          </ul>
          <h2>Get in touch</h2>
          <p>
            Found an error? Have a topic request? Reach out at{' '}
            <a href="mailto:hello@geekoncloud.com">hello@geekoncloud.com</a>.
          </p>
        </div>
        <div className="mt-10">
          <Link href="/blog" className="btn-primary">Read the blog →</Link>
        </div>
      </div>
    </Layout>
  )
}
