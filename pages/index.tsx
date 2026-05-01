import Layout from '../components/Layout'
import PostCard from '../components/PostCard'
import Link from 'next/link'
import { getSortedPosts, Post } from '../lib/posts'

interface HomeProps { posts: Post[] }

export default function Home({ posts }: HomeProps) {
  const featured = posts[0]
  const recent = posts.slice(1, 7)

  return (
    <Layout>
      {/* Hero */}
      <section className="relative overflow-hidden bg-ink-900 text-white">
        {/* Grid pattern */}
        <div className="absolute inset-0" style={{
          backgroundImage: 'linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)',
          backgroundSize: '40px 40px'
        }}/>
        {/* Glow */}
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[300px] bg-cloud-600/20 rounded-full blur-3xl pointer-events-none"/>

        <div className="relative max-w-5xl mx-auto px-4 sm:px-6 py-20 lg:py-28">
          <div className="max-w-2xl">
            {/* Badge */}
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/5 border border-white/10 text-xs font-mono text-cloud-300 mb-6">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse"/>
              DevOps · Cloud · Infrastructure · Updated daily with AI
            </div>

            <h1 className="font-display text-4xl sm:text-5xl lg:text-6xl font-bold leading-[1.1] mb-5">
              Engineering insights
              <span className="block text-transparent bg-clip-text bg-gradient-to-r from-cloud-400 to-blue-400">
                from the trenches
              </span>
            </h1>

            <p className="text-ink-300 text-lg leading-relaxed mb-8 max-w-lg">
              Practical deep-dives on Kubernetes, Terraform, CI/CD, cloud cost and platform engineering — written by practitioners, for practitioners.
            </p>

            <div className="flex flex-wrap items-center gap-3">
              <Link href="/blog" className="inline-flex items-center gap-2 px-6 py-3 bg-cloud-600 hover:bg-cloud-700 text-white text-sm font-medium rounded-xl transition-colors shadow-lg shadow-cloud-900/30">
                Read the blog
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3"/>
                </svg>
              </Link>
              <Link href="/ask" className="inline-flex items-center gap-2 px-6 py-3 bg-white/10 hover:bg-white/15 text-white text-sm font-medium rounded-xl transition-colors border border-white/10">
                <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse"/>
                Ask That IT Guy
              </Link>
            </div>
          </div>

          {/* Stats bar */}
          <div className="mt-14 pt-8 border-t border-white/10 flex flex-wrap gap-8">
            {[
              { label: 'Posts published', value: `${posts.length}+` },
              { label: 'Topics covered', value: '12+' },
              { label: 'AI-powered', value: '100%' },
              { label: 'Free forever', value: '✓' },
            ].map(s => (
              <div key={s.label}>
                <p className="text-2xl font-display font-bold text-white">{s.value}</p>
                <p className="text-xs text-ink-400 mt-0.5">{s.label}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Terminal code snippet strip */}
      <div className="bg-ink-800 border-y border-ink-700 py-3 overflow-hidden">
        <div className="max-w-5xl mx-auto px-4 sm:px-6">
          <code className="text-xs font-mono text-green-400 opacity-80 whitespace-nowrap">
            $ kubectl get pods --all-namespaces &nbsp;|&nbsp; grep -v Running &nbsp;&nbsp;
            <span className="text-cloud-400">→</span>&nbsp;
            $ terraform plan -out=tfplan &nbsp;&nbsp;
            <span className="text-cloud-400">→</span>&nbsp;
            $ helm upgrade --install myapp ./charts/myapp --atomic &nbsp;&nbsp;
            <span className="text-cloud-400">→</span>&nbsp;
            $ docker build --platform linux/amd64 -t geekoncloud:latest .
          </code>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-14">
        {/* Featured post */}
        {featured && (
          <section className="mb-14">
            <div className="flex items-center gap-3 mb-6">
              <span className="w-2 h-2 rounded-full bg-cloud-600"/>
              <h2 className="font-display text-xl font-bold text-ink-900">Latest post</h2>
              <div className="h-px flex-1 bg-ink-100"/>
            </div>
            <PostCard post={featured} featured />
          </section>
        )}

        {/* Recent posts */}
        {recent.length > 0 && (
          <section className="mb-14">
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-3">
                <span className="w-2 h-2 rounded-full bg-cloud-600"/>
                <h2 className="font-display text-xl font-bold text-ink-900">Recent posts</h2>
              </div>
              <Link href="/blog" className="text-sm text-cloud-600 hover:text-cloud-700 font-medium inline-flex items-center gap-1">
                View all <span>→</span>
              </Link>
            </div>
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {recent.map(post => <PostCard key={post.slug} post={post} />)}
            </div>
          </section>
        )}

        {/* Two column bottom section */}
        <div className="grid sm:grid-cols-2 gap-5">
          {/* Topics */}
          <section className="rounded-2xl border border-ink-100 p-7">
            <div className="flex items-center gap-2 mb-4">
              <span className="w-2 h-2 rounded-full bg-cloud-600"/>
              <h2 className="font-display text-lg font-bold text-ink-900">Topics</h2>
            </div>
            <div className="flex flex-wrap gap-2">
              {['Kubernetes','Terraform','CI/CD','Cloud Cost','GitOps','Observability','Platform Engineering','SRE','DevSecOps','FinOps'].map(t => (
                <Link key={t} href={`/tags/${t.toLowerCase().replace(/ /g,'-')}`}
                  className="tag hover:bg-cloud-100 hover:border-cloud-200 transition-colors text-xs">
                  {t}
                </Link>
              ))}
            </div>
          </section>

          {/* That IT Guy CTA */}
          <section className="rounded-2xl bg-ink-900 p-7 relative overflow-hidden">
            <div className="absolute inset-0" style={{
              backgroundImage: 'radial-gradient(circle at 1px 1px, rgba(255,255,255,0.04) 1px, transparent 0)',
              backgroundSize: '20px 20px'
            }}/>
            <div className="relative">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-8 h-8 rounded-lg bg-cloud-600 flex items-center justify-center">
                  <svg viewBox="0 0 20 20" className="w-4 h-4" fill="none">
                    <rect x="2" y="2" width="16" height="11" rx="2" stroke="white" strokeWidth="1.2"/>
                    <rect x="5" y="5" width="5" height="1" rx="0.5" fill="#60a5fa"/>
                    <rect x="5" y="7.5" width="10" height="1" rx="0.5" fill="white" fillOpacity="0.4"/>
                    <rect x="5" y="10" width="7" height="1" rx="0.5" fill="#6ee7b7"/>
                  </svg>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="font-display font-bold text-white text-sm">That IT Guy</span>
                  <span className="text-xs px-1.5 py-0.5 rounded-full bg-green-500/20 text-green-400 font-mono">online</span>
                </div>
              </div>
              <p className="text-ink-300 text-sm mb-4 leading-relaxed">Got a DevOps question? Ask our AI expert — real answers with actual commands and configs.</p>
              <Link href="/ask" className="inline-flex items-center gap-2 px-4 py-2 bg-cloud-600 hover:bg-cloud-700 text-white text-sm font-medium rounded-lg transition-colors">
                Ask a question →
              </Link>
            </div>
          </section>
        </div>
      </div>
    </Layout>
  )
}

export async function getStaticProps() {
  const posts = getSortedPosts()
  return { props: { posts } }
}
