import Layout from '../../components/Layout'
import Link from 'next/link'
import { getSortedPosts } from '../../lib/posts'

interface TagsProps { tags: { name: string; count: number }[] }

export default function TagsPage({ tags }: TagsProps) {
  return (
    <Layout title="Topics" description="Browse all DevOps and Cloud topics on GeekOnCloud.">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-12">
        <h1 className="font-display text-4xl font-bold text-ink-900 mb-2">Topics</h1>
        <p className="text-ink-400 mb-10">Browse posts by topic</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {tags.map(({ name, count }) => (
            <Link key={name} href={`/tags/${name.toLowerCase().replace(/ /g, '-')}`}
              className="card p-4 flex flex-col gap-1 hover:border-cloud-200 group">
              <span className="font-medium text-ink-800 group-hover:text-cloud-600 transition-colors">{name}</span>
              <span className="text-xs text-ink-400">{count} post{count !== 1 ? 's' : ''}</span>
            </Link>
          ))}
        </div>
      </div>
    </Layout>
  )
}

export async function getStaticProps() {
  const posts = getSortedPosts()
  const tagMap: Record<string, number> = {}
  posts.forEach(p => p.tags.forEach(t => { tagMap[t] = (tagMap[t] || 0) + 1 }))
  const tags = Object.entries(tagMap).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count)
  return { props: { tags } }
}
