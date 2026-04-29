import Layout from '../../components/Layout'
import PostCard from '../../components/PostCard'
import Link from 'next/link'
import { getSortedPosts, Post } from '../../lib/posts'

interface TagProps { tag: string; posts: Post[] }

export default function TagPage({ tag, posts }: TagProps) {
  return (
    <Layout title={tag} description={`All posts tagged ${tag} on GeekOnCloud.`}>
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-12">
        <Link href="/tags" className="inline-flex items-center gap-1.5 text-sm text-ink-400 hover:text-ink-700 mb-6">
          ← All topics
        </Link>
        <div className="flex items-center gap-3 mb-8">
          <span className="tag text-base px-3 py-1">{tag}</span>
          <span className="text-ink-400 text-sm">{posts.length} post{posts.length !== 1 ? 's' : ''}</span>
        </div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {posts.map(post => <PostCard key={post.slug} post={post} />)}
        </div>
      </div>
    </Layout>
  )
}

export async function getStaticPaths() {
  const posts = getSortedPosts()
  const tags = [...new Set(posts.flatMap(p => p.tags))]
  return { paths: tags.map(tag => ({ params: { tag: tag.toLowerCase().replace(/ /g, '-') } })), fallback: false }
}

export async function getStaticProps({ params }: { params: { tag: string } }) {
  const posts = getSortedPosts()
  const tagName = params.tag.replace(/-/g, ' ')
  const filtered = posts.filter(p => p.tags.some(t => t.toLowerCase() === tagName))
  const matchedTag = filtered[0]?.tags.find(t => t.toLowerCase() === tagName) || tagName
  return { props: { tag: matchedTag, posts: filtered } }
}
