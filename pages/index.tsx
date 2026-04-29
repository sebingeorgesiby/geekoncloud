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
      <section className="relative overflow-hidden scanlines bg-ink-900 text-white py-20 px-4">
        <div className="absolute inset-0 opacity-5" style={{backgroundImage: 'radial-gradient(circle at 1px 1px, white 1px, transparent 0)', backgroundSize: '32px 32px'}} />
        <div className="relative max-w-5xl mx-auto">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-cloud-500/30 bg-cloud-500/10 text-cloud-300 text-xs font-mono mb-6 fade-up fade-up-1">
            <span className="w-1.5 h-1.5 rounded-full bg-cloud-400 animate-pulse" />
            DevOps · Cloud · Infrastructure
          </div>
          <h1 className="font-display text-4xl sm:text-5xl lg:text-6xl font-bold leading-tight mb-5 fade-up fade-up-2">
            Engineering insights<br />
            <span className="text-cloud-400">from the trenches</span>
          </h1>
          <p className="text-ink-300 text-lg max-w-xl leading-relaxed mb-8 fade-up fade-up-3">
            Practical deep-dives on Kubernetes, Terraform, CI/CD, cloud cost, and platform engineering — written by practitioners, for practitioners.
          </p>
          <div className="flex items-center gap-3 fade-up fade-up-4">
            <Link href="/blog" className="btn-primary">Read the blog</Link>
            <Link href="/tags" className="inline-flex items-center gap-2 px-5 py-2.5 bg-white/10 hover:bg-white/20 text-white text-sm font-medium rounded-lg transition-colors">
              Browse topics
            </Link>
          </div>
        </div>
      </section>

      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-14">
        {/* Featured post */}
        {featured && (
          <section className="mb-14">
            <div className="flex items-center gap-3 mb-5">
              <h2 className="font-display text-xl font-bold text-ink-900">Latest post</h2>
              <div className="h-px flex-1 bg-ink-100" />
            </div>
            <PostCard post={featured} featured />
          </section>
        )}

        {/* Recent posts */}
        {recent.length > 0 && (
          <section className="mb-14">
            <div className="flex items-center justify-between mb-5">
              <div className="flex items-center gap-3">
                <h2 className="font-display text-xl font-bold text-ink-900">Recent posts</h2>
                <div className="h-px w-20 bg-ink-100" />
              </div>
              <Link href="/blog" className="text-sm text-cloud-600 hover:text-cloud-700 font-medium">View all →</Link>
            </div>
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {recent.map(post => <PostCard key={post.slug} post={post} />)}
            </div>
          </section>
        )}

        {/* Topics strip */}
        <section className="rounded-2xl bg-ink-50 p-8 text-center">
          <h2 className="font-display text-2xl font-bold text-ink-900 mb-2">What I write about</h2>
          <p className="text-ink-500 text-sm mb-6">Deep dives into the tools and practices that make infrastructure teams move faster.</p>
          <div className="flex flex-wrap justify-center gap-2">
            {['Kubernetes','Terraform','CI/CD','Cloud Cost','GitOps','Observability','Platform Engineering','SRE','DevSecOps','FinOps'].map(t => (
              <Link key={t} href={`/tags/${t.toLowerCase().replace(/ /g,'-')}`} className="tag hover:bg-cloud-100 hover:border-cloud-200 transition-colors">
                {t}
              </Link>
            ))}
          </div>
        </section>
      </div>
    </Layout>
  )
}

export async function getStaticProps() {
  const posts = getSortedPosts()
  return { props: { posts } }
}
