import Link from 'next/link'

export default function Footer() {
  return (
    <footer className="border-t border-ink-100 mt-20 py-10">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-ink-400">
        <div className="flex items-center gap-2">
          <span className="flex items-center justify-center w-5 h-5 rounded bg-cloud-600 text-white font-display text-xs font-bold">G</span>
          <span className="font-display font-bold text-ink-700">geekoncloud.com</span>
        </div>
        <nav className="flex flex-wrap items-center gap-4 justify-center">
          <Link href="/" className="hover:text-ink-700 transition-colors">Home</Link>
          <Link href="/blog" className="hover:text-ink-700 transition-colors">Blog</Link>
          <Link href="/tags" className="hover:text-ink-700 transition-colors">Topics</Link>
          <Link href="/about" className="hover:text-ink-700 transition-colors">About</Link>
          <Link href="/rss.xml" className="hover:text-ink-700 transition-colors">RSS</Link>
        </nav>
        <p>© {new Date().getFullYear()} GeekOnCloud</p>
      </div>
    </footer>
  )
}
