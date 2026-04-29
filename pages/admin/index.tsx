import { useState, useEffect } from 'react'
import { useRouter } from 'next/router'
import Head from 'next/head'
import Link from 'next/link'
import { format } from 'date-fns'

interface PostMeta {
  slug: string; title: string; date: string; tags: string[]
  draft: boolean; readTime: number; excerpt: string
}

export default function AdminDashboard() {
  const [posts, setPosts] = useState<PostMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [deleting, setDeleting] = useState<string | null>(null)
  const router = useRouter()

  useEffect(() => { fetchPosts() }, [])

  async function fetchPosts() {
    const res = await fetch('/api/admin/posts')
    if (res.status === 401) { router.push('/admin/login'); return }
    const data = await res.json()
    setPosts(data.posts)
    setLoading(false)
  }

  async function handleDelete(slug: string) {
    if (!confirm(`Delete "${slug}"? This cannot be undone.`)) return
    setDeleting(slug)
    await fetch(`/api/admin/posts/${slug}`, { method: 'DELETE' })
    await fetchPosts()
    setDeleting(null)
  }

  async function handleLogout() {
    await fetch('/api/admin/logout', { method: 'POST' })
    router.push('/admin/login')
  }

  return (
    <>
      <Head><title>Admin Dashboard — GeekOnCloud</title></Head>
      <div className="min-h-screen" style={{background: '#09090b', color: '#e4e4e7'}}>
        {/* Topbar */}
        <header className="border-b sticky top-0 z-20" style={{borderColor: '#27272a', background: '#09090b'}}>
          <div className="max-w-6xl mx-auto px-4 sm:px-6 flex items-center justify-between h-14">
            <div className="flex items-center gap-3">
              <Link href="/" className="flex items-center gap-2">
                <span className="flex items-center justify-center w-7 h-7 rounded-md bg-cloud-600 text-white font-display text-xs font-bold">G</span>
              </Link>
              <span style={{color:'#3f3f46'}}>/</span>
              <span className="text-sm font-medium">Admin</span>
            </div>
            <div className="flex items-center gap-3">
              <Link href="/blog" target="_blank" className="text-xs px-3 py-1.5 rounded-md transition-colors"
                style={{color: '#71717a', background: '#18181b'}}>
                View blog ↗
              </Link>
              <button onClick={handleLogout} className="text-xs px-3 py-1.5 rounded-md transition-colors"
                style={{color: '#71717a', background: '#18181b'}}>
                Sign out
              </button>
            </div>
          </div>
        </header>

        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
          {/* Stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
            {[
              { label: 'Total posts', value: posts.length },
              { label: 'Published', value: posts.filter(p => !p.draft).length },
              { label: 'Drafts', value: posts.filter(p => p.draft).length },
              { label: 'Topics', value: [...new Set(posts.flatMap(p => p.tags))].length },
            ].map(s => (
              <div key={s.label} className="rounded-xl p-4" style={{background: '#18181b', border: '1px solid #27272a'}}>
                <p className="text-xs mb-1" style={{color: '#52525b'}}>{s.label}</p>
                <p className="text-2xl font-display font-bold text-white">{s.value}</p>
              </div>
            ))}
          </div>

          {/* Header */}
          <div className="flex items-center justify-between mb-5">
            <h1 className="font-display text-xl font-bold text-white">Posts</h1>
            <Link href="/admin/new" className="inline-flex items-center gap-2 px-4 py-2 bg-cloud-600 hover:bg-cloud-700 text-white text-sm font-medium rounded-lg transition-colors">
              + New post
            </Link>
          </div>

          {/* Table */}
          {loading ? (
            <div className="text-center py-20" style={{color: '#52525b'}}>Loading posts…</div>
          ) : posts.length === 0 ? (
            <div className="text-center py-20 rounded-xl" style={{border: '1px dashed #27272a', color: '#52525b'}}>
              <p className="mb-3">No posts yet</p>
              <Link href="/admin/new" className="text-cloud-400 text-sm hover:text-cloud-300">Create your first post →</Link>
            </div>
          ) : (
            <div className="rounded-xl overflow-hidden" style={{border: '1px solid #27272a'}}>
              <table className="w-full text-sm">
                <thead>
                  <tr style={{background: '#18181b', borderBottom: '1px solid #27272a'}}>
                    <th className="text-left px-4 py-3 font-medium" style={{color: '#71717a'}}>Title</th>
                    <th className="text-left px-4 py-3 font-medium hidden sm:table-cell" style={{color: '#71717a'}}>Tags</th>
                    <th className="text-left px-4 py-3 font-medium hidden md:table-cell" style={{color: '#71717a'}}>Date</th>
                    <th className="text-left px-4 py-3 font-medium" style={{color: '#71717a'}}>Status</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {posts.map((post, i) => (
                    <tr key={post.slug} style={{borderTop: i > 0 ? '1px solid #27272a' : undefined}}>
                      <td className="px-4 py-3">
                        <p className="font-medium text-white truncate max-w-xs">{post.title}</p>
                        <p className="text-xs mt-0.5" style={{color: '#52525b'}}>{post.slug}</p>
                      </td>
                      <td className="px-4 py-3 hidden sm:table-cell">
                        <div className="flex flex-wrap gap-1">
                          {post.tags.slice(0, 2).map(t => (
                            <span key={t} className="px-2 py-0.5 rounded-full text-xs" style={{background: '#1e3a5f', color: '#7cbaff'}}>{t}</span>
                          ))}
                          {post.tags.length > 2 && <span className="text-xs" style={{color: '#52525b'}}>+{post.tags.length - 2}</span>}
                        </div>
                      </td>
                      <td className="px-4 py-3 hidden md:table-cell" style={{color: '#71717a'}}>
                        {post.date ? format(new Date(post.date), 'MMM d, yyyy') : '—'}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${post.draft
                          ? 'bg-amber-500/10 text-amber-400'
                          : 'bg-green-500/10 text-green-400'}`}>
                          {post.draft ? 'Draft' : 'Published'}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2 justify-end">
                          <Link href={`/admin/edit/${post.slug}`}
                            className="text-xs px-2.5 py-1 rounded transition-colors" style={{color: '#a1a1aa', background: '#27272a'}}>
                            Edit
                          </Link>
                          <Link href={`/blog/${post.slug}`} target="_blank"
                            className="text-xs px-2.5 py-1 rounded transition-colors hidden sm:inline-flex" style={{color: '#a1a1aa', background: '#27272a'}}>
                            View
                          </Link>
                          <button onClick={() => handleDelete(post.slug)} disabled={deleting === post.slug}
                            className="text-xs px-2.5 py-1 rounded transition-colors" style={{color: '#f87171', background: '#27272a'}}>
                            {deleting === post.slug ? '…' : 'Del'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
