import Head from 'next/head'
import PostEditor from '../../../components/PostEditor'
import { GetServerSideProps } from 'next'
import { getPostBySlug } from '../../../lib/posts'
import { checkAuth } from '../../../lib/auth'
import matter from 'gray-matter'
import fs from 'fs'
import path from 'path'

interface EditProps {
  slug: string; title: string; excerpt: string
  tags: string; content: string; draft: boolean
}

export default function EditPost({ slug, title, excerpt, tags, content, draft }: EditProps) {
  return (
    <>
      <Head><title>Edit: {title} — GeekOnCloud Admin</title></Head>
      <PostEditor initialSlug={slug} initialTitle={title} initialExcerpt={excerpt}
        initialTags={tags} initialContent={content} initialDraft={draft} isEdit />
    </>
  )
}

export const getServerSideProps: GetServerSideProps = async ({ req, params }) => {
  const auth = req.cookies['admin_token']
  if (!auth) return { redirect: { destination: '/admin/login', permanent: false } }

  const slug = params?.slug as string
  const filePath = path.join(process.cwd(), 'posts', `${slug}.md`)
  if (!fs.existsSync(filePath)) return { notFound: true }

  const raw = fs.readFileSync(filePath, 'utf8')
  const { data, content } = matter(raw)

  return {
    props: {
      slug,
      title: data.title || '',
      excerpt: data.excerpt || '',
      tags: (data.tags || []).join(', '),
      content: content.trim(),
      draft: data.draft || false,
    }
  }
}
