import Layout from '../../components/Layout'
import PostCard from '../../components/PostCard'
import { getSortedPosts, Post } from '../../lib/posts'
import { useState } from 'react'

interface BlogProps { posts: Post[], allTags: string[] }

export default function Blog({ posts, allTags }: BlogProps) {
  const [search, setSearch] = useState('')
  const [activeTag, setActiveTag] = useState('')

  const filtered = posts.filter(p => {
    const matchSearch = !search || p.title.toLowerCase().includes(search.toLowerCase()) || p.excerpt.toLowerCase().includes(search.toLowerCase())
    const matchTag = !activeTag || p.tags.some(t => t.toLowerCase() === activeTag.toLowerCase())
    return matchSearch && matchTag
  })

  return (
    <Layout title="Blog" description="All posts on DevOps, Cloud and Infrastructure engineering.">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-12">
        <div className="mb-10">
          <h1 className="font-display text-4xl font-bold text-ink-900 mb-2">All posts</h1>
          <p className="text-ink-400">{posts.length} articles on DevOps, Cloud & Infrastructure</p>
        </div>

        {/* Search + filter */}
        <div className="flex flex-col sm:flex-row gap-3 mb-8">
          <div className="relative flex-1">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text"
              placeholder="Search posts..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-9 pr-4 py-2.5 text-sm border border-ink-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-cloud-500/20 focus:border-cloud-400"
            />
          </div>
          {activeTag && (
            <button onClick={() => setActiveTag('')} className="btn-ghost text-cloud-600">
              ✕ {activeTag}
            </button>
          )}
        </div>

        {/* Tags */}
        <div className="flex flex-wrap gap-2 mb-8">
          {allTags.map(tag => (
            <button key={tag} onClick={() => setActiveTag(activeTag === tag ? '' : tag)}
              className={`tag cursor-pointer transition-all ${activeTag === tag ? 'bg-cloud-600 text-white border-cloud-600' : 'hover:bg-cloud-50'}`}>
              {tag}
            </button>
          ))}
        </div>

        {filtered.length === 0 ? (
          <div className="text-center py-20 text-ink-400">
            <p className="text-lg mb-2">No posts found</p>
            <p className="text-sm">Try a different search or tag</p>
          </div>
        ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {filtered.map(post => <PostCard key={post.slug} post={post} />)}
          </div>
        )}
      </div>
    </Layout>
  )
}

export async function getStaticProps() {
  const posts = getSortedPosts()
  const allTags = [...new Set<string>(posts.flatMap(p => p.tags))].sort()
  return { props: { posts, allTags } }
}
