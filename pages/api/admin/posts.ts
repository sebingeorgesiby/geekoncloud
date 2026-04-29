import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAuth } from '../../../lib/auth'
import { getAllPostsAdmin, savePost } from '../../../lib/posts'

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!requireAuth(req, res)) return

  if (req.method === 'GET') {
    const posts = getAllPostsAdmin()
    return res.status(200).json({ posts })
  }

  if (req.method === 'POST') {
    const { slug, title, excerpt, tags, content, draft } = req.body
    if (!slug || !title) return res.status(400).json({ error: 'slug and title required' })
    savePost(slug, {
      title,
      excerpt: excerpt || '',
      tags: tags || [],
      author: 'GeekOnCloud',
      date: new Date().toISOString().split('T')[0],
      draft: draft || false,
      coverImage: '',
    }, content || '')
    return res.status(200).json({ ok: true, slug })
  }

  res.status(405).end()
}
