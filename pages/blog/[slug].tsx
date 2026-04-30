import Layout from '../../components/Layout'
import Link from 'next/link'
import { getAllSlugs, getPostBySlug, Post } from '../../lib/posts'
import { format } from 'date-fns'

interface PostPageProps { post: Post }

export default function PostPage({ post }: PostPageProps) {
  return (
    <Layout title={post.title} description={post.excerpt} ogImage={post.coverImage}>
      <article className="max-w-3xl mx-auto px-4 sm:px-6 py-12">
        {/* Back */}
        <Link href="/blog" className="inline-flex items-center gap-1.5 text-sm text-ink-400 hover:text-ink-700 mb-8 transition-colors">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          All posts
        </Link>

        {/* Tags */}
        <div className="flex flex-wrap gap-2 mb-4">
          {post.tags.map(tag => (
            <Link key={tag} href={`/tags/${tag.toLowerCase().replace(/ /g, '-')}`} className="tag hover:bg-cloud-50 transition-colors">
              {tag}
            </Link>
          ))}
        </div>

        {/* Title */}
        <h1 className="font-display text-3xl sm:text-4xl font-bold text-ink-900 leading-tight mb-5">
          {post.title}
        </h1>

        {/* Meta */}
        <div className="flex flex-wrap items-center gap-3 text-sm text-ink-400 mb-8 pb-8 border-b border-ink-100">
          <span className="font-medium text-ink-600">{post.author}</span>
          <span>·</span>
          <time>{format(new Date(post.date), 'MMMM d, yyyy')}</time>
          <span>·</span>
          <span>{post.readTime} min read</span>
        </div>

        {/* Content */}
        <div
          className="prose prose-zinc max-w-none
            prose-headings:font-display prose-headings:font-bold
            prose-a:text-cloud-600 hover:prose-a:text-cloud-700
            prose-code:text-cloud-700 prose-code:bg-cloud-50 prose-code:border prose-code:border-cloud-100
            prose-pre:bg-ink-900 prose-pre:text-ink-100
            prose-blockquote:border-cloud-400 prose-blockquote:text-ink-500
            prose-img:rounded-xl prose-img:shadow-sm"
          dangerouslySetInnerHTML={{ __html: post.content || '' }}
        />

        {/* Footer */}
        <div className="mt-14 pt-8 border-t border-ink-100 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-ink-700 mb-1">Written by {post.author}</p>
            <p className="text-sm text-ink-400">DevOps & Infrastructure engineer at geekoncloud.com</p>
          </div>
          <Link href="/blog" className="btn-primary text-sm">Read more posts →</Link>
        </div>
      </article>
    </Layout>
  )
}

export async function getStaticPaths() {
  return { paths: getAllSlugs(), fallback: 'blocking' }
}

export async function getStaticProps({ params }: { params: { slug: string } }) {
  const post = await getPostBySlug(params.slug)
  if (!post) return { notFound: true }
  return { props: { post } }
}
