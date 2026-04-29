import { useState } from 'react'
import { useRouter } from 'next/router'
import Head from 'next/head'

export default function AdminLogin() {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    if (res.ok) {
      router.push('/admin')
    } else {
      setError('Incorrect password')
    }
    setLoading(false)
  }

  return (
    <>
      <Head><title>Admin — GeekOnCloud</title></Head>
      <div className="min-h-screen bg-ink-950 flex items-center justify-center p-4" style={{background: '#09090b'}}>
        <div className="w-full max-w-sm">
          <div className="flex items-center gap-3 mb-8 justify-center">
            <span className="flex items-center justify-center w-9 h-9 rounded-lg bg-cloud-600 text-white font-display text-sm font-bold">G</span>
            <span className="font-display text-xl font-bold text-white">geekoncloud</span>
          </div>
          <div className="bg-ink-800 rounded-2xl p-7 border border-ink-700" style={{background: '#18181b', borderColor: '#27272a'}}>
            <h1 className="font-display text-xl font-bold text-white mb-1">Admin</h1>
            <p className="text-sm mb-6" style={{color: '#71717a'}}>Enter your password to continue</p>
            <form onSubmit={handleSubmit} className="space-y-4">
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="Password"
                className="w-full px-4 py-2.5 rounded-lg text-sm bg-ink-900 border border-ink-600 text-white placeholder-ink-500 focus:outline-none focus:ring-2 focus:ring-cloud-500/40 focus:border-cloud-500"
                style={{background: '#09090b', borderColor: '#3f3f46'}}
                autoFocus
              />
              {error && <p className="text-red-400 text-xs">{error}</p>}
              <button type="submit" disabled={loading}
                className="w-full py-2.5 bg-cloud-600 hover:bg-cloud-700 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50">
                {loading ? 'Signing in…' : 'Sign in'}
              </button>
            </form>
          </div>
          <p className="text-center text-xs mt-4" style={{color: '#52525b'}}>
            Default password: <code className="font-mono">geekoncloud2025</code>
          </p>
        </div>
      </div>
    </>
  )
}
