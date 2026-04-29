import Link from 'next/link'
import { useState } from 'react'

export default function Navbar() {
  const [open, setOpen] = useState(false)
  return (
    <header className="sticky top-0 z-50 bg-white/90 backdrop-blur border-b border-ink-100">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 flex items-center justify-between h-14">
        <Link href="/" className="flex items-center gap-2 group">
          <span className="flex items-center justify-center w-7 h-7 rounded-md bg-cloud-600 text-white font-display text-xs font-bold">G</span>
          <span className="font-display text-base font-bold tracking-tight text-ink-900">geek<span className="text-cloud-600">on</span>cloud</span>
        </Link>
        <nav className="hidden sm:flex items-center gap-1">
          <Link href="/" className="btn-ghost">Home</Link>
          <Link href="/blog" className="btn-ghost">Blog</Link>
          <Link href="/tags" className="btn-ghost">Topics</Link>
          <Link href="/about" className="btn-ghost">About</Link>
        </nav>
        <button className="sm:hidden p-2 rounded-lg hover:bg-ink-50" onClick={() => setOpen(!open)} aria-label="Menu">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            {open ? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  : <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />}
          </svg>
        </button>
      </div>
      {open && (
        <div className="sm:hidden border-t border-ink-100 px-4 py-3 space-y-1 bg-white">
          {['/', '/blog', '/tags', '/about'].map((href, i) => (
            <Link key={href} href={href} className="block px-3 py-2 rounded-lg hover:bg-ink-50 text-sm text-ink-700"
              onClick={() => setOpen(false)}>
              {['Home', 'Blog', 'Topics', 'About'][i]}
            </Link>
          ))}
        </div>
      )}
    </header>
  )
}
