import Link from 'next/link'
import { useState } from 'react'
import { useRouter } from 'next/router'

export default function Navbar() {
  const [open, setOpen] = useState(false)
  const router = useRouter()

  const links = [
    { href: '/', label: 'Home' },
    { href: '/blog', label: 'Blog' },
    { href: '/tags', label: 'Topics' },
    { href: '/about', label: 'About' },
  ]

  return (
    <header className="sticky top-0 z-50 bg-white/95 backdrop-blur-sm border-b border-ink-100 shadow-sm">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 flex items-center justify-between h-16">

        {/* Logo */}
        <Link href="/" className="flex items-center gap-3 group">
          {/* IT-themed terminal icon */}
          <div className="relative w-9 h-9 rounded-xl bg-ink-900 flex items-center justify-center shadow-md group-hover:bg-ink-800 transition-colors overflow-hidden">
            <svg viewBox="0 0 36 36" className="w-6 h-6" fill="none">
              {/* Terminal prompt */}
              <path d="M6 12l5 4-5 4" stroke="#60a5fa" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              {/* Cursor */}
              <rect x="14" y="18" width="10" height="2.5" rx="1" fill="#34d399"/>
              {/* Blink dot */}
              <rect x="25" y="18" width="2.5" height="2.5" rx="0.5" fill="white" opacity="0.8"/>
            </svg>
            {/* Online indicator */}
            <span className="absolute top-0.5 right-0.5 w-2 h-2 bg-green-400 rounded-full border border-ink-900"/>
          </div>
          <div className="flex flex-col">
            <span className="font-display text-base font-bold tracking-tight text-ink-900 leading-none">
              geek<span className="text-cloud-600">on</span>cloud
            </span>
            <span className="text-ink-400 text-xs font-mono leading-none mt-0.5">DevOps & Cloud</span>
          </div>
        </Link>

        {/* Desktop nav */}
        <nav className="hidden sm:flex items-center gap-1">
          {links.map(({ href, label }) => (
            <Link key={href} href={href}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors
                ${router.pathname === href
                  ? 'bg-cloud-50 text-cloud-700'
                  : 'text-ink-600 hover:text-ink-900 hover:bg-ink-50'}`}>
              {label}
            </Link>
          ))}

          {/* Ask AI — special button */}
          <Link href="/ask"
            className="ml-2 inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-ink-900 hover:bg-ink-800 text-white text-sm font-medium transition-colors shadow-sm">
            <svg viewBox="0 0 20 20" className="w-4 h-4" fill="none">
              <rect x="2" y="2" width="16" height="11" rx="2" fill="white" fillOpacity="0.15" stroke="white" strokeWidth="1.2"/>
              <rect x="4" y="4" width="12" height="7" rx="1" fill="white" fillOpacity="0.1"/>
              <rect x="6" y="6" width="5" height="1" rx="0.5" fill="#60a5fa"/>
              <rect x="6" y="8.5" width="8" height="1" rx="0.5" fill="white" fillOpacity="0.5"/>
              <rect x="8" y="13" width="4" height="1.5" rx="0.5" fill="white" fillOpacity="0.3"/>
              <rect x="6" y="14.5" width="8" height="1.5" rx="0.5" fill="white" fillOpacity="0.3"/>
            </svg>
            That IT Guy
            <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse"/>
          </Link>
        </nav>

        {/* Mobile menu button */}
        <button className="sm:hidden p-2 rounded-lg hover:bg-ink-50 text-ink-600" onClick={() => setOpen(!open)}>
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            {open
              ? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
              : <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16"/>}
          </svg>
        </button>
      </div>

      {/* Mobile menu */}
      {open && (
        <div className="sm:hidden border-t border-ink-100 bg-white px-4 py-3 space-y-1 shadow-lg">
          {links.map(({ href, label }) => (
            <Link key={href} href={href}
              className="block px-3 py-2.5 rounded-lg text-sm text-ink-700 hover:bg-ink-50 font-medium"
              onClick={() => setOpen(false)}>
              {label}
            </Link>
          ))}
          <Link href="/ask"
            className="flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm font-medium bg-ink-900 text-white mt-2"
            onClick={() => setOpen(false)}>
            <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse"/>
            That IT Guy — Ask AI
          </Link>
        </div>
      )}
    </header>
  )
}
