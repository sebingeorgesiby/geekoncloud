import Link from 'next/link'
import { format } from 'date-fns'
import { Post } from '../lib/posts'

export default function PostCard({ post, featured = false }: { post: Post; featured?: boolean }) {
  return (
    <Link href={`/blog/${post.slug}`} className={`card p-6 flex flex-col gap-3 group ${featured ? 'sm:col-span-2' : ''}`}>
      <div className="flex items-center gap-2 flex-wrap">
        {post.tags.slice(0, 3).map(tag => (
          <span key={tag} className="tag">{tag}</span>
        ))}
      </div>
      <h2 className={`font-display font-bold text-ink-900 group-hover:text-cloud-600 transition-colors leading-snug ${featured ? 'text-2xl' : 'text-lg'}`}>
        {post.title}
      </h2>
      <p className="text-ink-500 text-sm leading-relaxed line-clamp-2">{post.excerpt}</p>
      <div className="flex items-center gap-3 text-xs text-ink-400 mt-auto pt-2 border-t border-ink-50">
        <span>{post.author}</span>
        <span>·</span>
        <span>{format(new Date(post.date), 'MMM d, yyyy')}</span>
        <span>·</span>
        <span>{post.readTime} min read</span>
      </div>
    </Link>
  )
}
