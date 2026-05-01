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
      content: "Hey! I'm the GeekOnCloud AI assistant — a DevOps and Cloud Infrastructure expert. Ask me anything about Kubernetes, Terraform, CI/CD, cloud cost, observability, or anything else in the DevOps space. I'll give you real, practitioner-level answers.",
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
        body: JSON.stringify({
          messages: [...messages, userMsg].map(m => ({
            role: m.role,
            content: m.content,
          })),
        }),
      })
      const data = await res.json()
      setMessages(prev => [...prev, { role: 'assistant', content: data.content }])
    } catch {
      setMessages(prev => [...prev, { role: 'assistant', content: 'Sorry, something went wrong. Please try again.' }])
    }
    setLoading(false)
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  const suggestions = [
    'How do I debug CrashLoopBackOff in Kubernetes?',
    'Best way to structure Terraform for multiple environments?',
    'How do I set up Prometheus alerting?',
    'What is GitOps and how do I get started?',
    'How do I reduce AWS costs on EKS?',
    'Explain Kubernetes resource limits vs requests',
  ]

  return (
    <Layout
      title="Ask the DevOps AI"
      description="Get instant answers to DevOps, Kubernetes, Terraform, and Cloud Infrastructure questions from an AI expert."
    >
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 flex flex-col" style={{ minHeight: 'calc(100vh - 120px)' }}>
        {/* Header */}
        <div className="mb-6">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-9 h-9 rounded-xl bg-cloud-600 flex items-center justify-center text-white text-sm font-bold font-display">AI</div>
            <div>
              <h1 className="font-display text-2xl font-bold text-ink-900">Ask the DevOps AI</h1>
              <p className="text-sm text-ink-400">Powered by Claude — expert answers on Kubernetes, Terraform, CI/CD & more</p>
            </div>
          </div>
        </div>

        {/* Suggestions — only show before first user message */}
        {messages.length === 1 && (
          <div className="mb-6">
            <p className="text-xs font-medium text-ink-400 mb-3 uppercase tracking-wide">Try asking</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {suggestions.map(s => (
                <button key={s} onClick={() => { setInput(s); inputRef.current?.focus() }}
                  className="text-left text-sm px-4 py-3 rounded-xl border border-ink-100 hover:border-cloud-200 hover:bg-cloud-50 text-ink-600 hover:text-cloud-700 transition-all">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Messages */}
        <div className="flex-1 space-y-4 mb-6">
          {messages.map((msg, i) => (
            <div key={i} className={`flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
              {/* Avatar */}
              <div className={`flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold
                ${msg.role === 'assistant' ? 'bg-cloud-600 text-white' : 'bg-ink-800 text-white'}`}>
                {msg.role === 'assistant' ? 'AI' : 'You'}
              </div>
              {/* Bubble */}
              <div className={`max-w-[85%] px-4 py-3 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap
                ${msg.role === 'assistant'
                  ? 'bg-white border border-ink-100 text-ink-800 rounded-tl-sm'
                  : 'bg-cloud-600 text-white rounded-tr-sm'}`}>
                {msg.content}
              </div>
            </div>
          ))}

          {/* Loading */}
          {loading && (
            <div className="flex gap-3">
              <div className="w-8 h-8 rounded-lg bg-cloud-600 flex items-center justify-center text-xs font-bold text-white flex-shrink-0">AI</div>
              <div className="bg-white border border-ink-100 rounded-2xl rounded-tl-sm px-4 py-3">
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
          <div className="flex gap-3 items-end bg-white border border-ink-200 rounded-2xl p-3 shadow-sm focus-within:border-cloud-400 focus-within:ring-2 focus-within:ring-cloud-500/10 transition-all">
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask any DevOps or cloud question..."
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
              className="flex-shrink-0 w-8 h-8 bg-cloud-600 hover:bg-cloud-700 disabled:opacity-40 text-white rounded-xl flex items-center justify-center transition-colors">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M12 5l7 7-7 7" />
              </svg>
            </button>
          </div>
          <p className="text-xs text-ink-300 text-center mt-2">Press Enter to send · Shift+Enter for new line</p>
        </div>
      </div>
    </Layout>
  )
}
