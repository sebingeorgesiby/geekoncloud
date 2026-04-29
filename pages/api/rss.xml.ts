import type { NextApiRequest, NextApiResponse } from 'next'
import { getSortedPosts } from '../../lib/posts'

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const posts = getSortedPosts().slice(0, 20)
  const baseUrl = 'https://geekoncloud.com'

  const items = posts.map(post => `
    <item>
      <title><![CDATA[${post.title}]]></title>
      <link>${baseUrl}/blog/${post.slug}</link>
      <guid>${baseUrl}/blog/${post.slug}</guid>
      <pubDate>${new Date(post.date).toUTCString()}</pubDate>
      <description><![CDATA[${post.excerpt}]]></description>
      ${post.tags.map(t => `<category>${t}</category>`).join('')}
    </item>`).join('')

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>GeekOnCloud</title>
    <link>${baseUrl}</link>
    <description>DevOps, Cloud &amp; Infrastructure engineering blog</description>
    <language>en</language>
    <atom:link href="${baseUrl}/rss.xml" rel="self" type="application/rss+xml"/>
    ${items}
  </channel>
</rss>`

  res.setHeader('Content-Type', 'application/xml')
  res.status(200).send(xml)
}
