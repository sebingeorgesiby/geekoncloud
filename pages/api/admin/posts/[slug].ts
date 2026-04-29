import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAuth } from '../../../../lib/auth'
import { savePost, deletePost } from '../../../../lib/posts'
import fs from 'fs'
import path from 'path'
import matter from 'gray-matter'

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!requireAuth(req, res)) return
  const slug = req.query.slug as string

  if (req.method === 'PUT') {
    const { title, excerpt, tags, content, draft } = req.body

    // Preserve original date
    const filePath = path.join(process.cwd(), 'posts', `${slug}.md`)
    let originalDate = new Date().toISOString().split('T')[0]
    if (fs.existsSync(filePath)) {
      const { data } = matter(fs.readFileSync(filePath, 'utf8'))
      if (data.date) originalDate = data.date
    }

    savePost(slug, {
      title,
      excerpt: excerpt || '',
      tags: tags || [],
      author: 'GeekOnCloud',
      date: originalDate,
      draft: draft || false,
      coverImage: '',
    }, content || '')
    return res.status(200).json({ ok: true })
  }

  if (req.method === 'DELETE') {
    deletePost(slug)
    return res.status(200).json({ ok: true })
  }

  res.status(405).end()
}
