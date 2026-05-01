import { useState, useRef, useEffect } from 'react'
import Layout from '../components/Layout'

interface Message {
  role: 'user' | 'assistant'
  content: string
}

export default function AskPage() {
  const [messages, setMessages] = useState<Message[]>([
    {
      role: 'assistant',
      content: "Hey! I'm That IT Guy — your DevOps and Cloud Infrastructure expert. Ask me anything about Kubernetes, Terraform, CI/CD, cloud costs, observability, or anything in the infrastructure space. I give real, practitioner-level answers with actual commands and configs.",
    },
  ])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function sendMessage() {
    const text = input.trim()
    if (!text || loading) return
    const userMsg: Message = { role: 'user', content: text }
    setMessages(prev => [...prev, userMsg])
    setInput('')
    setLoading(true)
    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [...messages, userMsg] }),
      })
      const data = await res.json()
      if (data.error) {
        setMessages(prev => [...prev, { role: 'assistant', content: 'Error: ' + data.error }])
      } else if (data.content) {
        setMessages(prev => [...prev, { role: 'assistant', content: data.content }])
      } else {
        setMessages(prev => [...prev, { role: 'assistant', content: 'No response received. Please try again.' }])
      }
    } catch (err: any) {
      setMessages(prev => [...prev, { role: 'assistant', content: 'Connection error: ' + (err.message || 'Please try again.') }])
    }
    setLoading(false)
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() }
  }

  const suggestions = [
    'How do I debug CrashLoopBackOff in Kubernetes?',
    'Best Terraform structure for multiple environments?',
    'Set up Prometheus alerting from scratch?',
    'What is GitOps and how do I start?',
    'How do I reduce AWS costs on EKS?',
    'Explain resource limits vs requests in K8s',
  ]

  return (
    <Layout title="That IT Guy — DevOps AI Assistant" description="Ask That IT Guy anything about Kubernetes, Terraform, CI/CD and cloud infrastructure. Real answers instantly.">
      {/* Page hero */}
      <div className="bg-gradient-to-b from-ink-900 to-ink-800 text-white py-10 px-4">
        <div className="max-w-3xl mx-auto flex items-center gap-5">
          {/* Avatar */}
          <div className="relative flex-shrink-0">
            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-cloud-500 to-cloud-700 flex items-center justify-center shadow-lg shadow-cloud-900/40">
              <svg viewBox="0 0 40 40" className="w-10 h-10" fill="none">
                {/* Monitor */}
                <rect x="4" y="6" width="32" height="22" rx="3" fill="white" fillOpacity="0.15" stroke="white" strokeWidth="1.5"/>
                {/* Screen content */}
                <rect x="8" y="10" width="24" height="14" rx="1.5" fill="white" fillOpacity="0.1"/>
                {/* Code lines */}
                <rect x="11" y="13" width="10" height="1.5" rx="0.75" fill="#60a5fa"/>
                <rect x="11" y="16.5" width="16" height="1.5" rx="0.75" fill="white" fillOpacity="0.5"/>
                <rect x="11" y="20" width="13" height="1.5" rx="0.75" fill="#34d399"/>
                {/* Cursor blink */}
                <rect x="25" y="20" width="1.5" height="1.5" rx="0.5" fill="white"/>
                {/* Stand */}
                <rect x="17" y="28" width="6" height="3" rx="1" fill="white" fillOpacity="0.3"/>
                <rect x="13" y="30.5" width="14" height="2" rx="1" fill="white" fillOpacity="0.3"/>
              </svg>
            </div>
            <span className="absolute -bottom-1 -right-1 w-4 h-4 bg-green-400 rounded-full border-2 border-ink-900" />
          </div>
          <div>
            <div className="flex items-center gap-2 mb-1">
              <h1 className="font-display text-2xl font-bold">That IT Guy</h1>
              <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/20 text-green-400 font-mono">online</span>
            </div>
            <p className="text-ink-300 text-sm">AI-powered DevOps & Cloud Infrastructure expert</p>
            <p className="text-ink-400 text-xs mt-1">Kubernetes · Terraform · CI/CD · Cloud Cost · SRE · GitOps</p>
          </div>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 flex flex-col" style={{ minHeight: 'calc(100vh - 280px)' }}>
        {/* Suggestions */}
        {messages.length === 1 && (
          <div className="mb-6">
            <p className="text-xs font-medium text-ink-400 mb-3 uppercase tracking-wide">Suggested questions</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {suggestions.map(s => (
                <button key={s} onClick={() => { setInput(s); inputRef.current?.focus() }}
                  className="text-left text-sm px-4 py-3 rounded-xl border border-ink-100 hover:border-cloud-300 hover:bg-cloud-50 text-ink-600 hover:text-cloud-700 transition-all group">
                  <span className="text-cloud-400 mr-1.5 group-hover:text-cloud-500">→</span>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Messages */}
        <div className="flex-1 space-y-5 mb-6">
          {messages.map((msg, i) => (
            <div key={i} className={`flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
              {/* Avatar */}
              {msg.role === 'assistant' ? (
                <div className="flex-shrink-0 w-9 h-9 rounded-xl bg-gradient-to-br from-cloud-500 to-cloud-700 flex items-center justify-center shadow-sm">
                  <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
                    <rect x="2" y="3" width="20" height="14" rx="2" fill="white" fillOpacity="0.2" stroke="white" strokeWidth="1.2"/>
                    <rect x="5" y="6" width="14" height="8" rx="1" fill="white" fillOpacity="0.15"/>
                    <rect x="7" y="8" width="6" height="1" rx="0.5" fill="#93c5fd"/>
                    <rect x="7" y="10.5" width="10" height="1" rx="0.5" fill="white" fillOpacity="0.6"/>
                    <rect x="7" y="13" width="8" height="1" rx="0.5" fill="#6ee7b7"/>
                    <rect x="10" y="17" width="4" height="2" rx="0.5" fill="white" fillOpacity="0.3"/>
                    <rect x="8" y="18.5" width="8" height="1.5" rx="0.5" fill="white" fillOpacity="0.3"/>
                  </svg>
                </div>
              ) : (
                <div className="flex-shrink-0 w-9 h-9 rounded-xl bg-ink-700 flex items-center justify-center text-xs font-bold text-white">
                  You
                </div>
              )}
              {/* Bubble */}
              <div className={`max-w-[82%] px-4 py-3 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap
                ${msg.role === 'assistant'
                  ? 'bg-white border border-ink-100 text-ink-800 rounded-tl-sm shadow-sm'
                  : 'bg-gradient-to-br from-cloud-600 to-cloud-700 text-white rounded-tr-sm shadow-sm'}`}>
                {msg.content}
                {msg.role === 'assistant' && i === 0 && (
                  <p className="text-xs text-ink-400 mt-2 pt-2 border-t border-ink-100">— That IT Guy</p>
                )}
              </div>
            </div>
          ))}

          {/* Loading */}
          {loading && (
            <div className="flex gap-3">
              <div className="flex-shrink-0 w-9 h-9 rounded-xl bg-gradient-to-br from-cloud-500 to-cloud-700 flex items-center justify-center shadow-sm">
                <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
                  <rect x="2" y="3" width="20" height="14" rx="2" fill="white" fillOpacity="0.2" stroke="white" strokeWidth="1.2"/>
                  <rect x="5" y="6" width="14" height="8" rx="1" fill="white" fillOpacity="0.15"/>
                  <rect x="7" y="8" width="6" height="1" rx="0.5" fill="#93c5fd"/>
                  <rect x="7" y="10.5" width="10" height="1" rx="0.5" fill="white" fillOpacity="0.6"/>
                  <rect x="7" y="13" width="8" height="1" rx="0.5" fill="#6ee7b7"/>
                  <rect x="10" y="17" width="4" height="2" rx="0.5" fill="white" fillOpacity="0.3"/>
                  <rect x="8" y="18.5" width="8" height="1.5" rx="0.5" fill="white" fillOpacity="0.3"/>
                </svg>
              </div>
              <div className="bg-white border border-ink-100 rounded-2xl rounded-tl-sm px-4 py-3 shadow-sm">
                <div className="flex gap-1.5 items-center h-5">
                  {[0,1,2].map(i => (
                    <span key={i} className="w-2 h-2 bg-cloud-400 rounded-full animate-bounce"
                      style={{ animationDelay: `${i * 0.15}s` }} />
                  ))}
                </div>
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div className="sticky bottom-4">
          <div className="flex gap-3 items-end bg-white border border-ink-200 rounded-2xl p-3 shadow-md focus-within:border-cloud-400 focus-within:ring-2 focus-within:ring-cloud-500/10 transition-all">
            <textarea ref={inputRef} value={input} onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask That IT Guy anything about DevOps or cloud..."
              rows={1}
              className="flex-1 text-sm text-ink-900 placeholder-ink-400 resize-none focus:outline-none leading-relaxed"
              style={{ maxHeight: '120px' }}
              onInput={e => {
                const el = e.target as HTMLTextAreaElement
                el.style.height = 'auto'
                el.style.height = Math.min(el.scrollHeight, 120) + 'px'
              }}
            />
            <button onClick={sendMessage} disabled={loading || !input.trim()}
              className="flex-shrink-0 w-9 h-9 bg-gradient-to-br from-cloud-600 to-cloud-700 hover:from-cloud-700 hover:to-cloud-800 disabled:opacity-40 text-white rounded-xl flex items-center justify-center transition-all shadow-sm">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M12 5l7 7-7 7" />
              </svg>
            </button>
          </div>
          <p className="text-xs text-ink-300 text-center mt-2">Enter to send · Shift+Enter for new line · Powered by Claude AI</p>
        </div>
      </div>
    </Layout>
  )
}
