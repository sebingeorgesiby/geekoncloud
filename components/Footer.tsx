import Link from 'next/link'

export default function Footer() {
  return (
    <footer className="bg-ink-900 text-white mt-20">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-12">
        <div className="grid sm:grid-cols-3 gap-8 mb-10">
          {/* Brand */}
          <div>
            <Link href="/" className="flex items-center gap-3 mb-3 group">
              <div className="w-9 h-9 rounded-xl bg-ink-800 border border-ink-700 flex items-center justify-center">
                <svg viewBox="0 0 36 36" className="w-6 h-6" fill="none">
                  <path d="M6 12l5 4-5 4" stroke="#60a5fa" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  <rect x="14" y="18" width="10" height="2.5" rx="1" fill="#34d399"/>
                  <rect x="25" y="18" width="2.5" height="2.5" rx="0.5" fill="white" opacity="0.8"/>
                </svg>
              </div>
              <span className="font-display text-base font-bold">geek<span className="text-cloud-400">on</span>cloud</span>
            </Link>
            <p className="text-ink-400 text-sm leading-relaxed">Practical DevOps and Cloud Infrastructure guides for engineers who ship.</p>
          </div>

          {/* Links */}
          <div>
            <p className="text-xs font-semibold text-ink-400 uppercase tracking-wider mb-3">Navigate</p>
            <div className="space-y-2">
              {[['/', 'Home'], ['/blog', 'Blog'], ['/tags', 'Topics'], ['/about', 'About']].map(([href, label]) => (
                <Link key={href} href={href} className="block text-sm text-ink-300 hover:text-white transition-colors">{label}</Link>
              ))}
            </div>
          </div>

          {/* AI */}
          <div>
            <p className="text-xs font-semibold text-ink-400 uppercase tracking-wider mb-3">AI Assistant</p>
            <Link href="/ask" className="flex items-center gap-3 p-3 rounded-xl bg-ink-800 border border-ink-700 hover:border-cloud-600 transition-colors group">
              <div className="w-8 h-8 rounded-lg bg-cloud-600 flex items-center justify-center flex-shrink-0">
                <svg viewBox="0 0 20 20" className="w-4 h-4" fill="none">
                  <rect x="2" y="2" width="16" height="11" rx="2" stroke="white" strokeWidth="1.2"/>
                  <rect x="5" y="5" width="5" height="1" rx="0.5" fill="#93c5fd"/>
                  <rect x="5" y="7.5" width="10" height="1" rx="0.5" fill="white" fillOpacity="0.5"/>
                  <rect x="5" y="10" width="7" height="1" rx="0.5" fill="#6ee7b7"/>
                </svg>
              </div>
              <div>
                <p className="text-sm font-medium text-white group-hover:text-cloud-300 transition-colors">That IT Guy</p>
                <p className="text-xs text-ink-400">Ask a DevOps question</p>
              </div>
            </Link>
          </div>
        </div>

        <div className="border-t border-ink-800 pt-6 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-ink-500">
          <p>© {new Date().getFullYear()} GeekOnCloud — geekoncloud.com</p>
          <div className="flex items-center gap-4">
            <Link href="/rss.xml" className="hover:text-ink-300 transition-colors">RSS Feed</Link>
            <span>·</span>
            <p>Powered by Claude AI</p>
          </div>
        </div>
      </div>
    </footer>
  )
}
