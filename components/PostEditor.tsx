import { useState, useCallback } from 'react'
import { useRouter } from 'next/router'

interface EditorProps {
  initialSlug?: string
  initialTitle?: string
  initialExcerpt?: string
  initialTags?: string
  initialContent?: string
  initialDraft?: boolean
  isEdit?: boolean
}

export default function PostEditor({
  initialSlug = '',
  initialTitle = '',
  initialExcerpt = '',
  initialTags = '',
  initialContent = '',
  initialDraft = false,
  isEdit = false,
}: EditorProps) {
  const router = useRouter()
  const [title, setTitle] = useState(initialTitle)
  const [excerpt, setExcerpt] = useState(initialExcerpt)
  const [tags, setTags] = useState(initialTags)
  const [content, setContent] = useState(initialContent)
  const [draft, setDraft] = useState(initialDraft)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [aiPrompt, setAiPrompt] = useState('')
  const [aiLoading, setAiLoading] = useState(false)
  const [aiMode, setAiMode] = useState<'draft'|'improve'|'outline'|'seo'|'title'>('draft')
  const [tab, setTab] = useState<'write'|'ai'>('write')

  const slug = isEdit ? initialSlug : title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')

  async function handleSave() {
    if (!title.trim()) { setError('Title is required'); return }
    setSaving(true); setError('')
    const res = await fetch(`/api/admin/posts${isEdit ? `/${initialSlug}` : ''}`, {
      method: isEdit ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, title, excerpt, tags: tags.split(',').map(t => t.trim()).filter(Boolean), content, draft }),
    })
    if (res.ok) {
      router.push('/admin')
    } else {
      const d = await res.json()
      setError(d.error || 'Failed to save')
    }
    setSaving(false)
  }

  async function runAI() {
    if (!aiPrompt.trim() && aiMode !== 'improve') return
    setAiLoading(true)
    const prompts: Record<string, string> = {
      draft: `Write a complete, technical blog post for geekoncloud.com (DevOps/Cloud/Infrastructure blog) about: "${aiPrompt}". Write in markdown with ## headings, code blocks, and practical examples. ~1000 words. Practitioner-level depth.`,
      improve: `Improve this blog post for a DevOps engineering blog. Make it more engaging, clearer, and technically precise. Return the improved markdown:\n\n${content}`,
      outline: `Create a detailed markdown outline for a DevOps/Infrastructure blog post about: "${aiPrompt}". Include ## and ### headings with brief notes for each section.`,
      seo: `Write an SEO-optimised excerpt (155 chars max) and 5 relevant tags for a DevOps blog post titled "${title || aiPrompt}". Return as:\nExcerpt: ...\nTags: tag1, tag2, tag3, tag4, tag5`,
      title: `Generate 6 SEO-friendly blog post title variants for a DevOps/Cloud engineering blog about: "${aiPrompt}". Return as a numbered list.`,
    }
    try {
      const res = await fetch('/api/admin/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: prompts[aiMode] }),
      })
      const data = await res.json()
      const text = data.content || ''
      if (aiMode === 'draft' || aiMode === 'outline' || aiMode === 'improve') {
        setContent(text)
        setTab('write')
      } else if (aiMode === 'seo') {
        const excerptMatch = text.match(/Excerpt:\s*(.+)/i)
        const tagsMatch = text.match(/Tags:\s*(.+)/i)
        if (excerptMatch) setExcerpt(excerptMatch[1].trim())
        if (tagsMatch) setTags(tagsMatch[1].trim())
        setTab('write')
      }
    } catch {}
    setAiLoading(false)
  }

  const inputCls = "w-full px-4 py-2.5 rounded-lg text-sm text-white placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500"
  const inputStyle = {background: '#18181b', border: '1px solid #3f3f46'}

  return (
    <div className="min-h-screen" style={{background: '#09090b', color: '#e4e4e7'}}>
      {/* Top bar */}
      <header className="sticky top-0 z-20 border-b" style={{borderColor: '#27272a', background: '#09090b'}}>
        <div className="max-w-6xl mx-auto px-4 flex items-center justify-between h-14">
          <div className="flex items-center gap-3">
            <button onClick={() => router.push('/admin')} className="text-sm" style={{color: '#71717a'}}>← Admin</button>
            <span style={{color: '#3f3f46'}}>/</span>
            <span className="text-sm font-medium">{isEdit ? 'Edit post' : 'New post'}</span>
            {slug && <span className="text-xs px-2 py-0.5 rounded font-mono" style={{background: '#18181b', color: '#52525b'}}>{slug}</span>}
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm cursor-pointer" style={{color: draft ? '#f59e0b' : '#a1a1aa'}}>
              <input type="checkbox" checked={draft} onChange={e => setDraft(e.target.checked)} className="rounded" />
              Draft
            </label>
            <button onClick={handleSave} disabled={saving}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50">
              {saving ? 'Saving…' : isEdit ? 'Update' : 'Publish'}
            </button>
          </div>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-4 py-6 grid lg:grid-cols-[1fr_340px] gap-6">
        {/* Main editor */}
        <div className="space-y-4">
          {error && <div className="text-sm text-red-400 px-4 py-2 rounded-lg" style={{background: '#2d1515'}}>{error}</div>}

          <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Post title…"
            className={inputCls} style={{...inputStyle, fontSize: '1.25rem', fontFamily: 'Syne, sans-serif', fontWeight: '700', padding: '14px 16px'}} />

          <textarea value={excerpt} onChange={e => setExcerpt(e.target.value)} placeholder="Short excerpt / meta description (155 chars)…"
            rows={2} className={inputCls} style={{...inputStyle, resize: 'none'}} />

          <input value={tags} onChange={e => setTags(e.target.value)} placeholder="Tags (comma-separated): Kubernetes, Terraform, CI/CD"
            className={inputCls} style={inputStyle} />

          {/* Tab bar */}
          <div className="flex gap-1 border-b" style={{borderColor: '#27272a'}}>
            {(['write', 'ai'] as const).map(t => (
              <button key={t} onClick={() => setTab(t)}
                className={`px-4 py-2.5 text-sm font-medium transition-colors capitalize ${tab === t ? 'text-white border-b-2 border-blue-500' : ''}`}
                style={{color: tab === t ? undefined : '#71717a'}}>
                {t === 'ai' ? '✦ AI Assistant' : 'Write'}
              </button>
            ))}
          </div>

          {tab === 'write' ? (
            <textarea value={content} onChange={e => setContent(e.target.value)}
              placeholder="Write your post in Markdown…&#10;&#10;## Introduction&#10;&#10;Start writing here…"
              rows={28}
              className="w-full px-4 py-3 rounded-xl text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              style={{...inputStyle, resize: 'vertical', lineHeight: '1.7', color: '#e4e4e7'}} />
          ) : (
            <div className="rounded-xl p-5 space-y-4" style={{background: '#18181b', border: '1px solid #27272a'}}>
              <p className="text-sm font-medium text-white">Claude AI Assistant</p>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {([['draft','Draft post'],['improve','Improve'],['outline','Outline'],['seo','SEO meta'],['title','Titles']] as const).map(([m, l]) => (
                  <button key={m} onClick={() => setAiMode(m)}
                    className={`px-3 py-2 rounded-lg text-xs font-medium transition-colors text-left ${aiMode === m ? 'bg-blue-600 text-white' : ''}`}
                    style={aiMode !== m ? {background: '#27272a', color: '#a1a1aa'} : {}}>
                    {l}
                  </button>
                ))}
              </div>
              {aiMode !== 'improve' && (
                <textarea value={aiPrompt} onChange={e => setAiPrompt(e.target.value)}
                  placeholder={aiMode === 'seo' ? 'Topic or post title to optimise…' : 'Describe the post topic or enter a title…'}
                  rows={3} className={`${inputCls} font-sans`}
                  style={{...inputStyle, resize: 'none'}} />
              )}
              {aiMode === 'improve' && (
                <p className="text-xs" style={{color: '#52525b'}}>Will improve the current content in the editor.</p>
              )}
              <button onClick={runAI} disabled={aiLoading}
                className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50">
                {aiLoading ? 'Generating…' : `Run — ${['Draft post','Improve content','Generate outline','Generate SEO meta','Generate titles'][['draft','improve','outline','seo','title'].indexOf(aiMode)]}`}
              </button>
            </div>
          )}
        </div>

        {/* Preview panel */}
        <div className="space-y-4">
          <div className="rounded-xl p-4 sticky top-20" style={{background: '#18181b', border: '1px solid #27272a'}}>
            <p className="text-xs font-medium mb-3" style={{color: '#71717a'}}>Preview</p>
            {title && <p className="font-display font-bold text-white text-lg leading-snug mb-2">{title}</p>}
            {excerpt && <p className="text-xs leading-relaxed mb-3" style={{color: '#71717a'}}>{excerpt}</p>}
            {tags && (
              <div className="flex flex-wrap gap-1.5 mb-3">
                {tags.split(',').filter(Boolean).map(t => (
                  <span key={t} className="px-2 py-0.5 rounded-full text-xs" style={{background: '#1e3a5f', color: '#7cbaff'}}>{t.trim()}</span>
                ))}
              </div>
            )}
            {content && (
              <div className="text-xs leading-relaxed mt-3 pt-3" style={{borderTop: '1px solid #27272a', color: '#71717a', maxHeight: '200px', overflow: 'hidden'}}>
                {content.slice(0, 300)}…
              </div>
            )}
            {!title && !content && (
              <p className="text-xs" style={{color: '#3f3f46'}}>Start writing to see a preview</p>
            )}
          </div>

          <div className="rounded-xl p-4" style={{background: '#18181b', border: '1px solid #27272a'}}>
            <p className="text-xs font-medium mb-3" style={{color: '#71717a'}}>Tips</p>
            <ul className="text-xs space-y-1.5" style={{color: '#52525b'}}>
              <li>Use ## for H2 headings</li>
              <li>```bash for code blocks</li>
              <li>Use the AI tab to draft or improve</li>
              <li>Save as Draft to publish later</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  )
}
