import fs from 'fs'
import path from 'path'
import matter from 'gray-matter'
import { remark } from 'remark'
import remarkHtml from 'remark-html'
import remarkGfm from 'remark-gfm'

const postsDirectory = path.join(process.cwd(), 'posts')

export interface Post {
  slug: string
  title: string
  date: string
  excerpt: string
  tags: string[]
  author: string
  readTime: number
  content?: string
  draft?: boolean
  coverImage?: string
}

function toDateStr(val: unknown): string {
  if (!val) return new Date().toISOString().split('T')[0]
  if (val instanceof Date) return val.toISOString().split('T')[0]
  return String(val)
}

function ensurePostsDir() {
  if (!fs.existsSync(postsDirectory)) {
    fs.mkdirSync(postsDirectory, { recursive: true })
  }
}

export function getSortedPosts(): Post[] {
  ensurePostsDir()
  const fileNames = fs.readdirSync(postsDirectory).filter(f => f.endsWith('.md'))

  const posts = fileNames.map(fileName => {
    const slug = fileName.replace(/\.md$/, '')
    const fullPath = path.join(postsDirectory, fileName)
    const fileContents = fs.readFileSync(fullPath, 'utf8')
    const { data, content } = matter(fileContents)
    const wordCount = content.split(/\s+/).length
    const readTime = Math.max(1, Math.ceil(wordCount / 200))

    return {
      slug,
      title: data.title || 'Untitled',
      date: toDateStr(data.date),
      excerpt: data.excerpt || content.slice(0, 180).trim() + '...',
      tags: data.tags || [],
      author: data.author || 'GeekOnCloud',
      readTime,
      draft: data.draft || false,
      coverImage: data.coverImage || '',
    } as Post
  })

  return posts
    .filter(p => !p.draft)
    .sort((a, b) => (a.date < b.date ? 1 : -1))
}

export function getAllSlugs() {
  ensurePostsDir()
  return fs.readdirSync(postsDirectory)
    .filter(f => f.endsWith('.md'))
    .map(f => ({ params: { slug: f.replace(/\.md$/, '') } }))
}

export async function getPostBySlug(slug: string): Promise<Post | null> {
  ensurePostsDir()
  const fullPath = path.join(postsDirectory, `${slug}.md`)
  if (!fs.existsSync(fullPath)) return null

  const fileContents = fs.readFileSync(fullPath, 'utf8')
  const { data, content } = matter(fileContents)

  const processed = await remark().use(remarkGfm).use(remarkHtml, { sanitize: false }).process(content)
  const htmlContent = processed.toString()
  const wordCount = content.split(/\s+/).length
  const readTime = Math.max(1, Math.ceil(wordCount / 200))

  return {
    slug,
    title: data.title || 'Untitled',
    date: toDateStr(data.date),
    excerpt: data.excerpt || content.slice(0, 180).trim() + '...',
    tags: data.tags || [],
    author: data.author || 'GeekOnCloud',
    readTime,
    draft: data.draft || false,
    coverImage: data.coverImage || '',
    content: htmlContent,
  }
}

export function savePost(
  slug: string,
  frontmatter: Omit<Post, 'slug' | 'readTime' | 'content'>,
  body: string
) {
  ensurePostsDir()
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? JSON.stringify(v) : v}`)
    .join('\n')
  const fileContent = `---\n${fm}\n---\n\n${body}`
  fs.writeFileSync(path.join(postsDirectory, `${slug}.md`), fileContent, 'utf8')
}

export function deletePost(slug: string) {
  ensurePostsDir()
  const fullPath = path.join(postsDirectory, `${slug}.md`)
  if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath)
}

export function getAllPostsAdmin(): Post[] {
  ensurePostsDir()
  const fileNames = fs.readdirSync(postsDirectory).filter(f => f.endsWith('.md'))
  return fileNames
    .map(fileName => {
      const slug = fileName.replace(/\.md$/, '')
      const fullPath = path.join(postsDirectory, fileName)
      const fileContents = fs.readFileSync(fullPath, 'utf8')
      const { data, content } = matter(fileContents)
      const wordCount = content.split(/\s+/).length
      return {
        slug,
        title: data.title || 'Untitled',
        date: toDateStr(data.date),
        excerpt: data.excerpt || '',
        tags: data.tags || [],
        author: data.author || 'GeekOnCloud',
        readTime: Math.max(1, Math.ceil(wordCount / 200)),
        draft: data.draft || false,
        coverImage: '',
      } as Post
    })
    .sort((a, b) => (a.date < b.date ? 1 : -1))
}
